#!/usr/bin/env node
/**
 * kw: the kommentarwache command line.
 *
 *   kw migrate
 *   kw setup [--battery v2] [--policy severity_led]
 *   kw import-prototype --results <results.jsonl> [--comments <comments.jsonl>]
 *                       [--codex-labels <labels.json>] [--connector <name>] [--policy <name>]
 *   kw eval --set <file.jsonl> --connector <name> [--battery v2] [--policy <name>] [--concurrency 4]
 *   kw replay --connector <name> --policy <name> [--misses]
 *   kw report --connector <name>
 */

import { parseArgs } from 'node:util';
import { createApiToken } from '../api/auth.js';
import { verifyAudit } from '../audit.js';
import { listSourcesWithModes, setConnectorModes } from '../connectors/modes.js';
import { pollConnector } from '../connectors/poll.js';
import { CONNECTOR_KINDS, defaultConnectorRegistry } from '../connectors/registry.js';
import { decryptSecrets, encryptSecrets, secretKeyFromEnv } from '../connectors/secrets.js';
import { appendAudit } from '../audit.js';
import { SYSTEM_ACTOR_ID, type ConnectorActionMode } from '../db/types.js';
import { createModerator } from '../auth/moderators.js';
import { loadDotenv, requireEnv } from '../config.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { reportConnector } from '../eval/report.js';
import { evalSet, importLabels, readEvalSet, replay } from '../eval/run.js';
import { runStage2Over } from '../eval/stage2run.js';
import { importPrototype } from '../import/prototype.js';
import { POLICIES } from '../policy/policy.js';
import { cachedPipeline } from '../providers/active.js';
import {
  envFromProcess,
  loadActivePipeline,
  OLLAMA_DEFAULT_MODEL,
  setupJevPipeline,
} from '../providers/registry.js';
import { startWorker } from '../worker.js';
import { datasetReadiness, exportDataset } from '../laya/export.js';
import { runGate } from '../laya/gate.js';
import { layaPromote, layaRollback, layaShadow } from '../laya/pipeline.js';
import { buildStage1Member, ensureLayaProvider } from '../providers/registry.js';
import pino from 'pino';

function policyByName(name: string) {
  const policy = POLICIES[name];
  if (!policy)
    throw new Error(`unknown policy ${name}; known: ${Object.keys(POLICIES).join(', ')}`);
  return policy;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  loadDotenv();
  if (!command || command === 'help' || command === '--help') {
    console.log(usage());
    return command ? 0 : 2;
  }

  const handle = createDb(requireEnv('DATABASE_URL'));
  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(handle.pool);
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
        return 0;
      }
      case 'setup': {
        const { values } = parseArgs({
          args: rest,
          options: {
            battery: { type: 'string', default: 'v2' },
            policy: { type: 'string', default: 'severity_led' },
            'stage2-model': {
              type: 'string',
              default: process.env['OLLAMA_MODEL'] ?? OLLAMA_DEFAULT_MODEL,
            },
            'no-stage2': { type: 'boolean', default: false },
          },
        });
        const stage2Model = values['no-stage2'] ? null : values['stage2-model'];
        const result = await setupJevPipeline(handle.db, {
          batteryShortName: values.battery,
          policy: policyByName(values.policy),
          stage2Model,
        });
        console.log(
          result.created
            ? `activated pipeline config ${result.pipelineConfigId}: Jev with battery ${values.battery}, policy ${values.policy}, ` +
                (stage2Model ? `stage 2 on Ollama ${stage2Model}` : 'no stage 2')
            : `pipeline config ${result.pipelineConfigId} already active with these settings`,
        );
        return 0;
      }
      case 'worker': {
        const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
        const runner = await startWorker({
          handle,
          pipeline: cachedPipeline(handle.db, envFromProcess()),
          log,
        });
        log.info('worker running; stop with Ctrl-C');
        await new Promise<void>((resolve) => {
          for (const signal of ['SIGINT', 'SIGTERM'] as const) {
            process.once(signal, () => {
              void runner.stop().then(resolve);
            });
          }
        });
        return 0;
      }
      case 'import-prototype': {
        const { values } = parseArgs({
          args: rest,
          options: {
            results: { type: 'string' },
            comments: { type: 'string' },
            'codex-labels': { type: 'string' },
            connector: { type: 'string', default: 'prototype' },
            policy: { type: 'string', default: 'severity_led' },
          },
        });
        if (!values.results) throw new Error('--results is required');
        const summary = await importPrototype(handle.db, {
          connectorName: values.connector,
          resultsPath: values.results,
          policyName: values.policy,
          ...(values.comments ? { commentsPath: values.comments } : {}),
          ...(values['codex-labels'] ? { codexLabelsPath: values['codex-labels'] } : {}),
        });
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
      case 'eval': {
        const { values } = parseArgs({
          args: rest,
          options: {
            set: { type: 'string' },
            connector: { type: 'string' },
            battery: { type: 'string', default: 'v2' },
            policy: { type: 'string', default: 'severity_led' },
            concurrency: { type: 'string', default: '4' },
          },
        });
        if (!values.set || !values.connector) throw new Error('--set and --connector are required');
        const items = await readEvalSet(values.set);
        const summary = await evalSet(handle.db, {
          connectorName: values.connector,
          items,
          batteryShortName: values.battery,
          policy: policyByName(values.policy),
          env: envFromProcess(),
          concurrency: Number(values.concurrency),
          log: (line) => console.error(line),
        });
        console.log(JSON.stringify(summary, null, 2));
        return summary.failed ? 1 : 0;
      }
      case 'replay': {
        const { values } = parseArgs({
          args: rest,
          options: {
            connector: { type: 'string' },
            policy: { type: 'string', default: 'severity_led' },
            misses: { type: 'boolean', default: false },
          },
        });
        if (!values.connector) throw new Error('--connector is required');
        const result = await replay(handle.db, values.connector, policyByName(values.policy));
        const { misses, ...rest2 } = result;
        console.log(JSON.stringify(values.misses ? result : rest2, null, 2));
        return 0;
      }
      case 'report': {
        const { values } = parseArgs({ args: rest, options: { connector: { type: 'string' } } });
        if (!values.connector) throw new Error('--connector is required');
        console.log(JSON.stringify(await reportConnector(handle.db, values.connector), null, 2));
        return 0;
      }
      case 'stage2-run': {
        const { values } = parseArgs({
          args: rest,
          options: { connector: { type: 'string' }, limit: { type: 'string' } },
        });
        if (!values.connector) throw new Error('--connector is required');
        const pipeline = await loadActivePipeline(handle.db, envFromProcess());
        if (!pipeline.judge)
          throw new Error('no stage-2 judge in the active pipeline; run `kw setup`');
        const summary = await runStage2Over(handle.db, {
          connectorName: values.connector,
          ctx: { judge: pipeline.judge, policy: pipeline.policy, policyId: pipeline.policyId },
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          log: (line) => console.error(line),
        });
        console.log(JSON.stringify(summary, null, 2));
        return summary.failed ? 1 : 0;
      }
      case 'labels': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            connector: { type: 'string' },
            file: { type: 'string' },
            source: { type: 'string' },
          },
        });
        if (positionals[0] !== 'import' || !values.connector || !values.file || !values.source) {
          throw new Error(
            'usage: kw labels import --connector <name> --file <json|jsonl> --source <name>',
          );
        }
        const result = await importLabels(handle.db, {
          connectorName: values.connector,
          path: values.file,
          source: values.source,
        });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'moderator': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            email: { type: 'string' },
            name: { type: 'string' },
            password: { type: 'string' },
          },
        });
        if (positionals[0] !== 'create' || !values.email || !values.name) {
          throw new Error(
            'usage: kw moderator create --email <email> --name <name> [--password <pw>]',
          );
        }
        const password = values.password ?? process.env['KW_MODERATOR_PASSWORD'];
        if (!password) throw new Error('pass --password or set KW_MODERATOR_PASSWORD');
        const id = await createModerator(handle.db, {
          email: values.email,
          name: values.name,
          password,
        });
        console.log(`moderator ${id} created: ${values.email}`);
        return 0;
      }
      case 'audit': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true });
        if (positionals[0] !== 'verify') throw new Error('usage: kw audit verify');
        const result = await verifyAudit(handle.db);
        console.log(
          result.brokenAt === null
            ? `audit log intact (${result.rows} rows)`
            : `audit log BROKEN at row ${result.brokenAt}`,
        );
        return result.brokenAt === null ? 0 : 1;
      }
      case 'source': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            source: { type: 'string' },
            hide: { type: 'string' },
            delete: { type: 'string' },
            ban: { type: 'string' },
            'max-per-hour': { type: 'string' },
          },
        });
        if (positionals[0] === 'list') {
          for (const s of await listSourcesWithModes(handle.db)) {
            console.log(
              `${s.id}\t${s.name}\t${s.kind}\t${s.comments} comments\thide=${s.modes.hide} delete=${s.modes.delete} ban=${s.modes.ban}` +
                (s.maxPerHour ? `\tcap=${s.maxPerHour}/h` : ''),
            );
          }
          return 0;
        }
        if (positionals[0] !== 'modes' || !values.source) {
          throw new Error(
            'usage: kw source list | kw source modes --source <name> --hide <mode> --delete <mode> --ban <mode> [--max-per-hour n]',
          );
        }
        const row = await handle.db
          .selectFrom('connectors')
          .select('id')
          .where('name', '=', values.source)
          .executeTakeFirst();
        if (!row) throw new Error(`no source named ${values.source}`);
        const pick = (v: string | undefined): ConnectorActionMode => {
          if (v === undefined) return 'off';
          if (!['off', 'dry_run', 'propose', 'auto'].includes(v))
            throw new Error(`mode must be off, dry_run, propose or auto; got ${v}`);
          return v as ConnectorActionMode;
        };
        await setConnectorModes(
          handle.db,
          row.id,
          { hide: pick(values.hide), delete: pick(values.delete), ban: pick(values.ban) },
          values['max-per-hour'] ? Number(values['max-per-hour']) : null,
          SYSTEM_ACTOR_ID,
          'cli',
        );
        console.log(`modes set for ${values.source}`);
        return 0;
      }
      case 'source-add': {
        const { values } = parseArgs({
          args: rest,
          options: {
            kind: { type: 'string' },
            name: { type: 'string' },
            config: { type: 'string', default: '{}' },
            secrets: { type: 'string', default: '{}' },
          },
        });
        if (!values.kind || !values.name)
          throw new Error(
            'usage: kw source-add --kind <kind> --name <name> [--config json] [--secrets json]',
          );
        if (!(CONNECTOR_KINDS as readonly string[]).includes(values.kind))
          throw new Error(`kind must be one of ${CONNECTOR_KINDS.join(', ')}`);
        const secrets = JSON.parse(values.secrets) as Record<string, unknown>;
        const secretsEnc = Object.keys(secrets).length
          ? encryptSecrets(secrets, secretKeyFromEnv())
          : null;
        const row = await handle.db
          .insertInto('connectors')
          .values({
            kind: values.kind,
            name: values.name,
            config: values.config,
            secrets_enc: secretsEnc,
          })
          .onConflict((oc) =>
            oc
              .column('name')
              .doUpdateSet({ kind: values.kind, config: values.config, secrets_enc: secretsEnc }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await appendAudit(handle.db, {
          actorId: SYSTEM_ACTOR_ID,
          via: 'cli',
          event: 'connector.saved',
          subjectType: 'connector',
          subjectId: row.id,
          payload: { kind: values.kind, name: values.name },
        });
        console.log(
          `source ${row.id} (${values.kind}) saved as ${values.name}; set its modes with kw source modes`,
        );
        return 0;
      }
      case 'source-test':
      case 'source-poll': {
        const { values } = parseArgs({ args: rest, options: { source: { type: 'string' } } });
        if (!values.source) throw new Error(`usage: kw ${command} --source <name>`);
        const row = await handle.db
          .selectFrom('connectors')
          .selectAll()
          .where('name', '=', values.source)
          .executeTakeFirstOrThrow(() => new Error(`no source named ${values.source}`));
        const env = envFromProcess();
        const registry = defaultConnectorRegistry();
        if (command === 'source-test') {
          const connector = registry.get({
            id: row.id,
            kind: row.kind,
            name: row.name,
            config: row.config,
            secrets: env.secretKey ? decryptSecrets(row.secrets_enc, env.secretKey) : {},
          });
          if (!connector) throw new Error(`no connector for kind ${row.kind}`);
          const result = connector.check
            ? await connector.check()
            : { ok: true, detail: `${row.kind} has no credential check` };
          console.log(
            `${result.ok ? 'ok' : 'FAILED'}: ${result.detail}; capabilities: ${[...connector.capabilities].join(', ')}`,
          );
          return result.ok ? 0 : 1;
        }
        const summary = await pollConnector(
          handle.db,
          { connectors: registry, secretKey: env.secretKey },
          row.id,
        );
        console.log(JSON.stringify(summary, null, 2));
        return summary.error ? 1 : 0;
      }
      case 'laya': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            model: { type: 'string', default: 'multilingual' },
            source: { type: 'string' },
            'no-shadow': { type: 'boolean', default: false },
          },
        });
        const env = envFromProcess();
        switch (positionals[0]) {
          case 'shadow': {
            const r = await layaShadow(handle.db, env, values.model);
            console.log(
              r.created
                ? `pipeline config ${r.pipelineConfigId}: ${r.providerName} now judges every comment as a shadow`
                : `${r.providerName} is already a shadow`,
            );
            return 0;
          }
          case 'promote': {
            const r = await layaPromote(handle.db, env, {
              model: values.model,
              keepShadow: !values['no-shadow'],
            });
            console.log(
              `pipeline config ${r.pipelineConfigId}: Laya is stage 1${values['no-shadow'] ? '' : ', the previous primary shadows it'}; ${r.demotedToPropose} auto delete/ban modes dropped to propose`,
            );
            return 0;
          }
          case 'rollback': {
            const r = await layaRollback(handle.db);
            console.log(`pipeline config ${r.pipelineConfigId} (version ${r.version}) restored`);
            return 0;
          }
          case 'gate': {
            if (!values.source)
              throw new Error('usage: kw laya gate --source <name> [--model multilingual]');
            const laya = await ensureLayaProvider(handle.db, env, values.model);
            const pipeline = await loadActivePipeline(handle.db, env);
            const candidate = await buildStage1Member(handle.db, env, laya.id);
            const r = await runGate(handle.db, {
              candidate,
              policy: pipeline.policy,
              sourceName: values.source,
              log: (l) => console.error(l),
            });
            console.log(JSON.stringify(r, null, 2));
            return r.passed ? 0 : 1;
          }
          default:
            throw new Error(
              'usage: kw laya <shadow | promote | rollback | gate> [--model m] [--source s] [--no-shadow]',
            );
        }
      }
      case 'dataset': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { out: { type: 'string' }, since: { type: 'string' } },
        });
        if (positionals[0] === 'readiness') {
          console.log(JSON.stringify(await datasetReadiness(handle.db), null, 2));
          return 0;
        }
        if (positionals[0] !== 'export' || !values.out)
          throw new Error(
            'usage: kw dataset export --out <file.jsonl> [--since YYYY-MM-DD] | kw dataset readiness',
          );
        const summary = await exportDataset(handle.db, {
          out: values.out,
          since: values.since ? new Date(values.since) : undefined,
        });
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
      case 'token': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            name: { type: 'string' },
            scopes: { type: 'string', default: 'moderate' },
          },
        });
        if (positionals[0] !== 'create' || !values.name)
          throw new Error('usage: kw token create --name <name> [--scopes a,b]');
        const { actorId, token } = await createApiToken(handle.db, {
          name: values.name,
          scopes: values.scopes.split(',').map((s) => s.trim()),
        });
        console.log(`actor ${actorId} created. Token (shown once):\n${token}`);
        return 0;
      }
      default:
        console.error(`unknown command: ${command}\n\n${usage()}`);
        return 2;
    }
  } finally {
    await handle.close();
  }
}

function usage(): string {
  return `usage: kw <command> [options]

  migrate                       apply pending SQL migrations
  setup                         activate Jev as stage 1 and Ollama as stage 2
      --battery <v1|v2>         default: v2
      --policy <name>           default: severity_led
      --stage2-model <name>     default: $OLLAMA_MODEL or gemma4:12b-it-qat
      --no-stage2               unsure comments go straight to the human queue
  worker                        run the background worker only (the server runs one too)
  import-prototype              import the prototype's results JSONL as closed comments
      --results <file>          required
      --comments <file>         optional, adds context and author index
      --codex-labels <file>     optional, second-reviewer labels
      --connector <name>        default: prototype
      --policy <name>           severity_led | strict | permissive | naive
  eval                          run a labelled JSONL set through stage 1 live and report
      --set <file> --connector <name>   required
      --battery <v1|v2> --policy <name> --concurrency <n>
  replay                        re-route stored answers under another policy, no model calls
      --connector <name> --policy <name> [--misses]
  report --connector <name>     counts per stage, stage-1 to stage-2 transitions, label agreement
  stage2-run --connector <name> run stage 2 over a connector's pending comments, serially
      [--limit <n>]
  labels import                 attach labels (JSON array or JSONL of {id, verdict}) to a connector
      --connector <name> --file <path> --source <name>
  source-add                    add or update a platform source (needs KW_SECRET_KEY for secrets)
      --kind <api|youtube|facebook|instagram|fake> --name <n> [--config json] [--secrets json]
  source-test --source <name>   check the credentials and list capabilities
  source-poll --source <name>   poll once now (the worker polls every 2 minutes)
  source list                   sources with their action modes
  source modes                  set how far a source may act: off | dry_run | propose | auto
      --source <name> --hide <mode> --delete <mode> --ban <mode> [--max-per-hour <n>]
  laya shadow|promote|rollback  the Laya migration as pipeline-config versions (see training/README.md)
      [--model multilingual] [--no-shadow]
  laya gate --source <name>     score a Laya checkpoint against labels and the primary
  dataset export --out <file>   Laya training JSONL from stored answers and human decisions
      [--since YYYY-MM-DD]
  dataset readiness             how far the labels are from the training targets
  moderator create              create a dashboard account
      --email <e> --name <n> [--password <pw> | $KW_MODERATOR_PASSWORD]
  audit verify                  check the audit log's hash chain
  token create --name <name>    create an API token (scopes: moderate; use * for all)
      [--scopes a,b]

DATABASE_URL is read from the environment or ./.env`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

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

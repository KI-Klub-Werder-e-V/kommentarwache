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
import { loadDotenv, requireEnv } from '../config.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { evalSet, importLabels, readEvalSet, replay } from '../eval/run.js';
import { importPrototype, reportConnector } from '../import/prototype.js';
import { POLICIES } from '../policy/policy.js';
import { envFromProcess, setupJevPipeline } from '../providers/registry.js';

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
          },
        });
        const result = await setupJevPipeline(handle.db, {
          batteryShortName: values.battery,
          policy: policyByName(values.policy),
        });
        console.log(
          result.created
            ? `activated pipeline config ${result.pipelineConfigId}: Jev with battery ${values.battery}, policy ${values.policy}`
            : `pipeline config ${result.pipelineConfigId} already active with these settings`,
        );
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
  setup                         activate Jev as stage 1 (needs TYPESAFE_API_KEY)
      --battery <v1|v2>         default: v2
      --policy <name>           default: severity_led
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
  report --connector <name>     verdict counts and agreement with labels
  labels import                 attach labels (JSON array or JSONL of {id, verdict}) to a connector
      --connector <name> --file <path> --source <name>
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

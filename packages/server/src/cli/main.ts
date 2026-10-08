#!/usr/bin/env node
/**
 * kw: the kommentarwache command line.
 *
 *   kw migrate
 *   kw import-prototype --results <results.jsonl> [--comments <comments.jsonl>]
 *                       [--codex-labels <labels.json>] [--connector <name>] [--policy <name>]
 *   kw report --connector <name>
 */

import { parseArgs } from 'node:util';
import { loadDotenv, requireEnv } from '../config.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { importPrototype, reportConnector } from '../import/prototype.js';

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
      case 'report': {
        const { values } = parseArgs({ args: rest, options: { connector: { type: 'string' } } });
        if (!values.connector) throw new Error('--connector is required');
        console.log(JSON.stringify(await reportConnector(handle.db, values.connector), null, 2));
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
  return `usage: kw <migrate | import-prototype | report> [options]

  migrate                     apply pending SQL migrations
  import-prototype            import the prototype's results JSONL as closed comments
      --results <file>        required
      --comments <file>       optional, adds context and author index
      --codex-labels <file>   optional, second-reviewer labels
      --connector <name>      default: prototype
      --policy <name>         severity_led | strict | permissive | naive
  report --connector <name>   verdict counts and agreement with labels

DATABASE_URL is read from the environment or ./.env`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

/**
 * Build providers from provider_configs rows, and keep the config rows for batteries,
 * policies and providers that the code knows about. Config rows are immutable versions:
 * these helpers only ever insert a missing row, never change one.
 */

import type { Kysely, Selectable } from 'kysely';
import { PolicySchema, type Battery, type Policy } from '@kommentarwache/contract';
import { applyLadder } from '../actions/engine.js';
import type { ConnectorRegistry } from '../connectors/connector.js';
import { defaultConnectorRegistry } from '../connectors/registry.js';
import { secretKeyFromEnv } from '../connectors/secrets.js';
import { makeEnqueueStage2 } from '../pipeline/queue.js';
import type { AfterDecision, EnqueueStage2 } from '../pipeline/stage1.js';
import { OllamaJudgeProvider, type JudgeProvider } from './llmjudge.js';
import { BATTERIES } from '../batteries/index.js';
import { SYSTEM_ACTOR_ID, type DB, type ProviderConfigsTable } from '../db/types.js';
import type { DecisionProvider } from './provider.js';
import {
  JEV_BASE_URL,
  JEV_COST_PER_INPUT_TOKEN,
  SystemOneClient,
  SystemOneProvider,
} from './systemone.js';

export interface ProviderEnv {
  typesafeApiKey?: string | undefined;
  layaApiKey?: string | undefined;
  ollamaUrl?: string | undefined;
  ollamaModel?: string | undefined;
  /** decoded KW_SECRET_KEY, when set */
  secretKey?: Buffer | undefined;
}

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'gemma4:12b-it-qat';

export function envFromProcess(): ProviderEnv {
  return {
    typesafeApiKey: process.env['TYPESAFE_API_KEY'],
    layaApiKey: process.env['LAYA_API_KEY'],
    ollamaUrl: process.env['OLLAMA_URL'],
    ollamaModel: process.env['OLLAMA_MODEL'],
    secretKey: process.env['KW_SECRET_KEY'] ? secretKeyFromEnv() : undefined,
  };
}

export function buildJudge(row: Selectable<ProviderConfigsTable>, env: ProviderEnv): JudgeProvider {
  if (row.kind !== 'llm_judge') throw new Error(`provider ${row.name} is not a stage-2 judge`);
  return new OllamaJudgeProvider({
    configId: row.id,
    name: row.name,
    baseUrl: row.base_url ?? env.ollamaUrl ?? OLLAMA_DEFAULT_URL,
    model: row.model ?? env.ollamaModel ?? OLLAMA_DEFAULT_MODEL,
  });
}

/** The config row for a stage-2 judge on Ollama. One row per model; the URL comes from env. */
export async function ensureOllamaJudge(
  db: Kysely<DB>,
  model: string,
): Promise<Selectable<ProviderConfigsTable>> {
  const name = `ollama-judge:${model}`;
  const found = await db
    .selectFrom('provider_configs')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found;
  return db
    .insertInto('provider_configs')
    .values({ name, kind: 'llm_judge', model, is_local: true })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function buildProvider(
  row: Selectable<ProviderConfigsTable>,
  battery: Battery,
  env: ProviderEnv,
): DecisionProvider {
  switch (row.kind) {
    case 'systemone': {
      const baseUrl = row.base_url ?? JEV_BASE_URL;
      const isJev = baseUrl.startsWith(JEV_BASE_URL);
      if (isJev && !env.typesafeApiKey)
        throw new Error('TYPESAFE_API_KEY is not set (needed for Jev)');
      return new SystemOneProvider({
        configId: row.id,
        name: row.name,
        battery,
        model: row.model ?? (isJev ? 'jev-latest' : 'multilingual'),
        client: new SystemOneClient({
          baseUrl,
          apiKey: isJev ? env.typesafeApiKey : env.layaApiKey,
        }),
        costPerInputToken: isJev ? JEV_COST_PER_INPUT_TOKEN : 0,
        isLocal: !isJev,
      });
    }
    default:
      throw new Error(`provider kind ${row.kind} is not implemented yet`);
  }
}

export async function ensureBattery(
  db: Kysely<DB>,
  shortName: string,
): Promise<{ id: number; battery: Battery; mapper: 'v1' | 'v2' }> {
  const known = BATTERIES[shortName];
  if (!known)
    throw new Error(`unknown battery ${shortName}; known: ${Object.keys(BATTERIES).join(', ')}`);
  const found = await db
    .selectFrom('batteries')
    .select('id')
    .where('name', '=', known.battery.name)
    .where('version', '=', known.battery.version)
    .executeTakeFirst();
  if (found) return { id: found.id, ...known };
  const row = await db
    .insertInto('batteries')
    .values({
      name: known.battery.name,
      version: known.battery.version,
      questions: JSON.stringify(known.battery.questions),
      mapper: known.mapper,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, ...known };
}

/**
 * Policy rows are immutable versions. The row whose spec equals the given policy is
 * reused; any difference, even one threshold, becomes the next version of that name.
 */
export async function ensurePolicy(db: Kysely<DB>, policy: Policy): Promise<number> {
  const versions = await db
    .selectFrom('policies')
    .select(['id', 'version', 'spec'])
    .where('name', '=', policy.name)
    .orderBy('version', 'desc')
    .execute();
  const wanted = JSON.stringify(policy);
  const same = versions.find((v) => JSON.stringify(v.spec) === wanted);
  if (same) return same.id;
  const row = await db
    .insertInto('policies')
    .values({
      name: policy.name,
      version: (versions[0]?.version ?? 0) + 1,
      spec: wanted,
      created_by: SYSTEM_ACTOR_ID,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function ensureJevProvider(
  db: Kysely<DB>,
  batteryShortName: string,
): Promise<Selectable<ProviderConfigsTable>> {
  const battery = await ensureBattery(db, batteryShortName);
  // Provider configs are immutable and point at one battery version, so the name
  // carries the version: a battery change is a new provider config.
  const name = `jev-${batteryShortName}@${battery.battery.version}`;
  const found = await db
    .selectFrom('provider_configs')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found;
  return db
    .insertInto('provider_configs')
    .values({
      name,
      kind: 'systemone',
      base_url: JEV_BASE_URL,
      model: 'jev-latest',
      battery_id: battery.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface ActivePipeline {
  pipelineConfigId: number;
  provider: DecisionProvider;
  batteryId: number;
  mapper: 'v1' | 'v2';
  policy: Policy;
  policyId: number;
  /** absent when no stage-2 judge is configured: unsure comments then wait for a human */
  judge?: JudgeProvider;
  enqueueStage2: EnqueueStage2;
  connectors: ConnectorRegistry;
  secretKey?: Buffer | undefined;
  afterDecision: AfterDecision;
}

/** The active pipeline config with its providers built and ready. */
export async function loadActivePipeline(
  db: Kysely<DB>,
  env: ProviderEnv,
  connectors: ConnectorRegistry = defaultConnectorRegistry(),
): Promise<ActivePipeline> {
  const config = await db
    .selectFrom('pipeline_configs')
    .selectAll()
    .where('activated_at', 'is not', null)
    .where('deactivated_at', 'is', null)
    .orderBy('version', 'desc')
    .executeTakeFirstOrThrow(() => new Error('no active pipeline config; run `kw setup`'));
  if (!config.s1_primary || !config.policy_id)
    throw new Error('active pipeline config has no stage-1 provider or policy');

  const providerRow = await db
    .selectFrom('provider_configs')
    .selectAll()
    .where('id', '=', config.s1_primary)
    .executeTakeFirstOrThrow();
  if (!providerRow.battery_id) throw new Error(`provider ${providerRow.name} has no battery`);
  const batteryRow = await db
    .selectFrom('batteries')
    .selectAll()
    .where('id', '=', providerRow.battery_id)
    .executeTakeFirstOrThrow();
  const policyRow = await db
    .selectFrom('policies')
    .selectAll()
    .where('id', '=', config.policy_id)
    .executeTakeFirstOrThrow();
  const policy = PolicySchema.safeParse(policyRow.spec);
  if (!policy.success) {
    throw new Error(
      `policy ${policyRow.name} v${policyRow.version} predates the current policy schema; run \`kw setup\``,
    );
  }

  const judgeRow = config.s2_primary
    ? await db
        .selectFrom('provider_configs')
        .selectAll()
        .where('id', '=', config.s2_primary)
        .executeTakeFirstOrThrow()
    : undefined;

  const mapper = batteryRow.mapper === 'v1' ? 'v1' : 'v2';
  const battery: Battery = {
    name: batteryRow.name,
    version: batteryRow.version,
    questions: batteryRow.questions,
  };
  return {
    pipelineConfigId: config.id,
    provider: buildProvider(providerRow, battery, env),
    batteryId: batteryRow.id,
    mapper,
    policy: policy.data,
    policyId: policyRow.id,
    ...(judgeRow ? { judge: buildJudge(judgeRow, env) } : {}),
    enqueueStage2: makeEnqueueStage2(),
    connectors,
    secretKey: env.secretKey,
    afterDecision: async (t) => {
      await applyLadder(db, { connectors, secretKey: env.secretKey }, policy.data, t);
    },
  };
}

/**
 * Activate a pipeline config with Jev as stage 1 under a named policy. A new version is
 * created only when the active one differs.
 */
export async function setupJevPipeline(
  db: Kysely<DB>,
  opts: {
    batteryShortName: string;
    policy: Policy;
    /** Ollama model for stage 2; null means no stage 2, unsure comments wait for a human */
    stage2Model: string | null;
  },
): Promise<{ pipelineConfigId: number; created: boolean }> {
  const provider = await ensureJevProvider(db, opts.batteryShortName);
  const policyId = await ensurePolicy(db, opts.policy);
  const judge = opts.stage2Model ? await ensureOllamaJudge(db, opts.stage2Model) : null;

  return db.transaction().execute(async (trx) => {
    const active = await trx
      .selectFrom('pipeline_configs')
      .selectAll()
      .where('activated_at', 'is not', null)
      .where('deactivated_at', 'is', null)
      .orderBy('version', 'desc')
      .executeTakeFirst();
    if (
      active &&
      active.s1_primary === provider.id &&
      active.policy_id === policyId &&
      active.s2_primary === (judge?.id ?? null)
    ) {
      return { pipelineConfigId: active.id, created: false };
    }
    if (active) {
      await trx
        .updateTable('pipeline_configs')
        .set({ deactivated_at: new Date() })
        .where('id', '=', active.id)
        .execute();
    }
    const latest = await trx
      .selectFrom('pipeline_configs')
      .select((eb) => eb.fn.max('version').as('v'))
      .executeTakeFirst();
    const row = await trx
      .insertInto('pipeline_configs')
      .values({
        version: (latest?.v ?? 0) + 1,
        s1_primary: provider.id,
        s2_primary: judge?.id ?? null,
        policy_id: policyId,
        activated_at: new Date(),
        activated_by: SYSTEM_ACTOR_ID,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { pipelineConfigId: row.id, created: true };
  });
}

/**
 * Build providers from provider_configs rows, and keep the config rows for batteries,
 * policies and providers that the code knows about. Config rows are immutable versions:
 * these helpers only ever insert a missing row, never change one.
 */

import type { Kysely, Selectable } from 'kysely';
import { PolicySchema, type Battery, type Policy, type MapperName } from '@kommentarwache/contract';
import { applyLadder } from '../actions/engine.js';
import { mapperName } from '../policy/policy.js';
import type { ConnectorRegistry } from '../connectors/connector.js';
import { defaultConnectorRegistry } from '../connectors/registry.js';
import { secretKeyFromEnv } from '../connectors/secrets.js';
import { makeEnqueueStage2 } from '../pipeline/queue.js';
import type { AfterDecision, EnqueueStage2, Stage1Member } from '../pipeline/stage1.js';
import { OllamaJudgeProvider, type JudgeProvider } from './llmjudge.js';
import { BATTERIES } from '../batteries/index.js';
import { SYSTEM_ACTOR_ID, type DB, type ProviderConfigsTable } from '../db/types.js';
import { OllamaGuardProvider } from './guard.js';
import { OpenAIModerationProvider } from './openai.js';
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
  layaUrl?: string | undefined;
  openaiApiKey?: string | undefined;
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
    layaUrl: process.env['LAYA_URL'],
    openaiApiKey: process.env['OPENAI_API_KEY'],
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
    case 'ollama_guard':
      return new OllamaGuardProvider({
        configId: row.id,
        name: row.name,
        baseUrl: row.base_url ?? env.ollamaUrl ?? OLLAMA_DEFAULT_URL,
        model: row.model ?? 'llama-guard3:1b',
      });
    case 'openai_moderation':
      if (!env.openaiApiKey)
        throw new Error('OPENAI_API_KEY is not set (needed for OpenAI moderation)');
      return new OpenAIModerationProvider({
        configId: row.id,
        name: row.name,
        apiKey: env.openaiApiKey,
        ...(row.model ? { model: row.model } : {}),
      });
    default:
      throw new Error(`provider kind ${row.kind} is not implemented yet`);
  }
}

export async function ensureBattery(
  db: Kysely<DB>,
  shortName: string,
): Promise<{ id: number; battery: Battery; mapper: MapperName }> {
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
  mapper: MapperName;
  policy: Policy;
  policyId: number;
  /** absent when no stage-2 judge is configured: unsure comments then wait for a human */
  judge?: JudgeProvider;
  enqueueStage2: EnqueueStage2;
  connectors: ConnectorRegistry;
  secretKey?: Buffer | undefined;
  afterDecision: AfterDecision;
  parallel?: Stage1Member[] | undefined;
  combiner?: 'primary_only' | 'all_agree_else_unsure' | undefined;
  shadows?: Stage1Member[] | undefined;
}

/** A stage-1 provider with its battery, from a provider_configs id. */
export async function buildStage1Member(
  db: Kysely<DB>,
  env: ProviderEnv,
  providerConfigId: number,
): Promise<Stage1Member> {
  const row = await db
    .selectFrom('provider_configs')
    .selectAll()
    .where('id', '=', providerConfigId)
    .executeTakeFirstOrThrow(() => new Error(`provider config ${providerConfigId} not found`));
  if (!row.battery_id) throw new Error(`provider ${row.name} has no battery`);
  const batteryRow = await db
    .selectFrom('batteries')
    .selectAll()
    .where('id', '=', row.battery_id)
    .executeTakeFirstOrThrow();
  const battery: Battery = {
    name: batteryRow.name,
    version: batteryRow.version,
    questions: batteryRow.questions,
  };
  return {
    provider: buildProvider(row, battery, env),
    batteryId: batteryRow.id,
    mapper: mapperName(batteryRow.mapper),
  };
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

  const mapper = mapperName(batteryRow.mapper);
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
    parallel: await Promise.all(config.s1_parallel.map((id) => buildStage1Member(db, env, id))),
    combiner: config.s1_combiner,
    shadows: await Promise.all(config.shadows.map((id) => buildStage1Member(db, env, id))),
  };
}

export const LAYA_DEFAULT_URL = 'http://localhost:8000';

/** The config row for a Laya checkpoint served by laya-serve, on battery v2. */
export async function ensureLayaProvider(
  db: Kysely<DB>,
  env: ProviderEnv,
  model: string,
): Promise<Selectable<ProviderConfigsTable>> {
  const battery = await ensureBattery(db, 'v2');
  const name = `laya-${model}@v2.${battery.battery.version}`;
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
      base_url: env.layaUrl ?? LAYA_DEFAULT_URL,
      model,
      battery_id: battery.id,
      is_local: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface PipelineSpec {
  s1Primary: number;
  s1Parallel?: number[];
  s1Combiner?: 'primary_only' | 'all_agree_else_unsure';
  s2Primary: number | null;
  shadows?: number[];
  policyId: number;
}

/** The active pipeline config row, if any. */
export async function activePipelineRow(db: Kysely<DB>) {
  return db
    .selectFrom('pipeline_configs')
    .selectAll()
    .where('activated_at', 'is not', null)
    .where('deactivated_at', 'is', null)
    .orderBy('version', 'desc')
    .executeTakeFirst();
}

/**
 * Activate a pipeline config. Configs are immutable versions: a new row is created only
 * when the active one differs, and the old one is deactivated, never changed.
 */
export async function activatePipeline(
  db: Kysely<DB>,
  spec: PipelineSpec,
  actorId = SYSTEM_ACTOR_ID,
): Promise<{ pipelineConfigId: number; created: boolean }> {
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const parallel = spec.s1Parallel ?? [];
  const shadows = spec.shadows ?? [];
  const combiner = spec.s1Combiner ?? 'primary_only';
  return db.transaction().execute(async (trx) => {
    const active = await activePipelineRow(trx);
    if (
      active &&
      active.s1_primary === spec.s1Primary &&
      active.policy_id === spec.policyId &&
      active.s2_primary === spec.s2Primary &&
      active.s1_combiner === combiner &&
      same(active.s1_parallel, parallel) &&
      same(active.shadows, shadows)
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
        s1_primary: spec.s1Primary,
        s1_parallel: parallel,
        s1_combiner: combiner,
        s2_primary: spec.s2Primary,
        shadows,
        policy_id: spec.policyId,
        activated_at: new Date(),
        activated_by: actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { pipelineConfigId: row.id, created: true };
  });
}

/**
 * Activate Jev as stage 1 under a named policy, keeping any parallel or shadow providers
 * of the active config. A new version is created only when something differs.
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
  const active = await activePipelineRow(db);
  return activatePipeline(db, {
    s1Primary: provider.id,
    s1Parallel: active?.s1_parallel ?? [],
    s1Combiner: active?.s1_combiner ?? 'primary_only',
    s2Primary: judge?.id ?? null,
    shadows: active?.shadows ?? [],
    policyId,
  });
}

/** A pseudo-battery row that only carries the mapper for a score-style provider. */
async function ensureMapperBattery(
  db: Kysely<DB>,
  name: string,
  mapper: 'guard' | 'openai',
): Promise<number> {
  const found = await db
    .selectFrom('batteries')
    .select('id')
    .where('name', '=', name)
    .where('version', '=', 1)
    .executeTakeFirst();
  if (found) return found.id;
  const row = await db
    .insertInto('batteries')
    .values({ name, version: 1, questions: JSON.stringify({}), mapper })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The config row for Llama Guard (or another guard model) on Ollama. */
export async function ensureGuardProvider(
  db: Kysely<DB>,
  model: string,
): Promise<Selectable<ProviderConfigsTable>> {
  const name = `guard:${model}`;
  const found = await db
    .selectFrom('provider_configs')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found;
  const batteryId = await ensureMapperBattery(db, 'guard', 'guard');
  return db
    .insertInto('provider_configs')
    .values({ name, kind: 'ollama_guard', model, battery_id: batteryId, is_local: true })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The config row for OpenAI's moderation endpoint. */
export async function ensureOpenAIModerationProvider(
  db: Kysely<DB>,
  model = 'omni-moderation-latest',
): Promise<Selectable<ProviderConfigsTable>> {
  const name = `openai-moderation:${model}`;
  const found = await db
    .selectFrom('provider_configs')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();
  if (found) return found;
  const batteryId = await ensureMapperBattery(db, 'openai-moderation', 'openai');
  return db
    .insertInto('provider_configs')
    .values({ name, kind: 'openai_moderation', model, battery_id: batteryId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Add any provider config as a stage-1 shadow or parallel member of the active pipeline. */
export async function addStage1Member(
  db: Kysely<DB>,
  providerConfigId: number,
  role: 'shadow' | 'parallel',
  actorId = SYSTEM_ACTOR_ID,
): Promise<{ pipelineConfigId: number; created: boolean }> {
  const active = await activePipelineRow(db);
  if (!active?.s1_primary || !active.policy_id)
    throw new Error('no active pipeline; run `kw setup` first');
  const add = (list: number[]) =>
    list.includes(providerConfigId) ? list : [...list, providerConfigId];
  return activatePipeline(
    db,
    {
      s1Primary: active.s1_primary,
      s1Parallel: role === 'parallel' ? add(active.s1_parallel) : active.s1_parallel,
      s1Combiner: role === 'parallel' ? 'all_agree_else_unsure' : active.s1_combiner,
      s2Primary: active.s2_primary,
      shadows: role === 'shadow' ? add(active.shadows) : active.shadows,
      policyId: active.policy_id,
    },
    actorId,
  );
}

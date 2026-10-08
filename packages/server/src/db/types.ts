/**
 * Kysely table types for the schema in migrations/. Kept by hand and checked against the
 * database by the migration test; regenerate with kysely-codegen once the schema settles.
 */

import type { ColumnType, Generated, JSONColumnType } from 'kysely';
import type {
  Answers,
  Category,
  CommentContext,
  Policy,
  Questions,
  Verdict,
} from '@kommentarwache/contract';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** a timestamp with a database default: optional on insert, a Date when read */
type TimestampWithDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T extends object | null> = JSONColumnType<T>;
type JsonObject = Record<string, unknown>;
/** a JSON column with a database default: optional on insert, still a string */
type JsonWithDefault<T extends object | null> = ColumnType<T, string | undefined, string>;

export type ActorType = 'system' | 'moderator' | 'agent';
export type Stage = 's1' | 's2' | 'human';
export type AssessmentStage = 's1' | 's2';
export type ProviderRole = 'primary' | 'parallel' | 'shadow';
export type ProviderKind =
  'systemone' | 'ollama_guard' | 'llm_judge' | 'openai_moderation' | 'import';
export type CommentState = 's1_pending' | 's2_pending' | 'human_pending' | 'closed';
export type DecisionVia = 'pipeline' | 'dashboard' | 'api' | 'mcp' | 'cli' | 'replay';
export type ActionType = 'hide' | 'unhide' | 'delete' | 'ban' | 'unban' | 'hold' | 'approve';
export type ActionMode = 'auto' | 'dry_run' | 'proposed' | 'manual';
export type ActionState =
  'planned' | 'executing' | 'succeeded' | 'failed' | 'simulated' | 'cancelled';
export type ConnectorActionMode = 'off' | 'dry_run' | 'propose' | 'auto';
export type ReviewReason =
  | 'both_unsure'
  | 'stage_disagree'
  | 's2_timeout'
  | 'provider_failure'
  | 'action_failed'
  | 'unsupported_action'
  | 'audit_sample'
  | 'shadow_diff'
  | 'proposed_action';

export interface ActorsTable {
  id: Generated<number>;
  type: ActorType;
  name: string;
  email: string | null;
  password_hash: string | null;
  token_hash: string | null;
  scopes: Generated<string[]>;
  owner_actor_id: number | null;
  created_at: TimestampWithDefault;
  disabled_at: Timestamp | null;
}

export interface SessionsTable {
  id_hash: string;
  actor_id: number;
  created_at: TimestampWithDefault;
  expires_at: Timestamp;
}

export interface BatteriesTable {
  id: Generated<number>;
  name: string;
  version: number;
  questions: Json<Questions>;
  mapper: string;
  created_at: TimestampWithDefault;
}

export interface PoliciesTable {
  id: Generated<number>;
  name: string;
  version: number;
  spec: Json<Policy>;
  created_by: number | null;
  created_at: TimestampWithDefault;
}

export interface ProviderConfigsTable {
  id: Generated<number>;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  model: string | null;
  battery_id: number | null;
  params: JsonWithDefault<Record<string, unknown>>;
  calibration: JsonWithDefault<Record<string, unknown>>;
  is_local: Generated<boolean>;
  created_at: TimestampWithDefault;
}

export interface PipelineConfigsTable {
  id: Generated<number>;
  version: number;
  s1_primary: number | null;
  s1_parallel: Generated<number[]>;
  s1_combiner: Generated<'primary_only' | 'all_agree_else_unsure'>;
  s2_primary: number | null;
  shadows: Generated<number[]>;
  policy_id: number | null;
  activated_at: Timestamp | null;
  activated_by: number | null;
  deactivated_at: Timestamp | null;
  created_at: TimestampWithDefault;
}

export interface ConnectorsTable {
  id: Generated<number>;
  kind: string;
  name: string;
  config: JsonWithDefault<Record<string, unknown>>;
  secrets_enc: Buffer | null;
  capabilities: Generated<string[]>;
  action_window_seconds: number | null;
  cursor: JsonWithDefault<Record<string, unknown>>;
  enabled: Generated<boolean>;
  breaker_open_at: Timestamp | null;
  created_at: TimestampWithDefault;
}

export interface ConnectorActionModesTable {
  connector_id: number;
  action_type: 'hide' | 'delete' | 'ban';
  mode: ConnectorActionMode;
  max_per_hour: number | null;
}

export interface AuthorsTable {
  id: Generated<number>;
  connector_id: number;
  platform_author_id: string;
  display_name: string | null;
  allowlisted: Generated<boolean>;
  banned_at: Timestamp | null;
  created_at: TimestampWithDefault;
}

export interface IngestEventsTable {
  id: Generated<number>;
  connector_id: number;
  dedupe_key: string;
  payload: Json<JsonObject>;
  received_at: TimestampWithDefault;
  processed_at: Timestamp | null;
}

export type { CommentContext };

export interface CommentsTable {
  id: Generated<number>;
  connector_id: number;
  platform_comment_id: string;
  author_id: number | null;
  parent_platform_id: string | null;
  thread_ref: string | null;
  permalink: string | null;
  text: string;
  content_hash: string;
  revision: Generated<number>;
  lang: string | null;
  context: JsonWithDefault<CommentContext>;
  platform_created_at: Timestamp | null;
  ingested_at: TimestampWithDefault;
  is_backfill: Generated<boolean>;
  state: CommentState;
  state_deadline_at: Timestamp | null;
  pipeline_config_id: number | null;
  final_verdict: Verdict | null;
  final_category: string | null;
  final_stage: Stage | null;
  closed_at: Timestamp | null;
  text_redacted_at: Timestamp | null;
}

export interface LabelsTable {
  id: Generated<number>;
  comment_id: number;
  source: string;
  verdict: Verdict;
  category: string | null;
  sentiment: string | null;
  note: string | null;
  created_at: TimestampWithDefault;
}

export interface AssessmentsTable {
  id: Generated<number>;
  comment_id: number;
  revision: number;
  provider_config_id: number;
  stage: AssessmentStage;
  role: ProviderRole;
  status: 'ok' | 'error' | 'timeout';
  model_version: string | null;
  battery_id: number | null;
  answers: Json<Answers> | null;
  raw: Json<JsonObject> | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  created_at: TimestampWithDefault;
}

export interface DecisionsTable {
  id: Generated<number>;
  comment_id: number;
  revision: number;
  stage: Stage;
  effective: Generated<boolean>;
  verdict: Verdict;
  category: Category | string;
  reasons: JsonWithDefault<string[]>;
  policy_id: number | null;
  provider_config_id: number | null;
  assessment_ids: Generated<number[]>;
  actor_id: number;
  via: DecisionVia;
  overrides_decision_id: number | null;
  replay_run_id: number | null;
  note: string | null;
  created_at: TimestampWithDefault;
}

export interface ReviewItemsTable {
  id: Generated<number>;
  comment_id: number;
  reason: ReviewReason;
  priority: Generated<number>;
  created_at: TimestampWithDefault;
  claimed_by: number | null;
  claimed_at: Timestamp | null;
  first_viewed_at: Timestamp | null;
  resolved_at: Timestamp | null;
  resolution_decision_id: number | null;
}

export interface ActionsTable {
  id: Generated<number>;
  connector_id: number;
  comment_id: number | null;
  author_id: number | null;
  action_type: ActionType;
  mode: ActionMode;
  rule: string | null;
  decision_id: number | null;
  actor_id: number;
  via: string;
  state: ActionState;
  reversible: boolean;
  idempotency_key: string;
  execute_after: Timestamp | null;
  attempts: Generated<number>;
  platform_response: Json<JsonObject> | null;
  error: string | null;
  undoes_action_id: number | null;
  undone_at: Timestamp | null;
  overturned_at: Timestamp | null;
  overturned_by_decision_id: number | null;
  created_at: TimestampWithDefault;
  executed_at: Timestamp | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  at: TimestampWithDefault;
  actor_id: number | null;
  via: string | null;
  event: string;
  subject_type: string | null;
  subject_id: number | null;
  payload: JsonWithDefault<Record<string, unknown>>;
  prev_hash: string | null;
  hash: string;
}

export interface DatasetExportsTable {
  id: Generated<number>;
  battery_id: number | null;
  filter: JsonWithDefault<Record<string, unknown>>;
  sha256: string | null;
  counts: JsonWithDefault<Record<string, number>>;
  created_by: number | null;
  created_at: TimestampWithDefault;
}

export interface DatasetItemsTable {
  export_id: number;
  comment_id: number;
  split: 'train' | 'calib' | 'test';
}

export interface EvaluationsTable {
  id: Generated<number>;
  provider_config_id: number | null;
  export_id: number | null;
  kind: string;
  metrics: JsonWithDefault<Record<string, unknown>>;
  gate_passed: boolean | null;
  decided_by: number | null;
  created_at: TimestampWithDefault;
}

export interface CommentOutcomesView {
  comment_id: number;
  connector_id: number;
  ingested_at: Timestamp;
  revision: number;
  state: CommentState;
  final_verdict: Verdict | null;
  final_category: string | null;
  final_stage: Stage | null;
  closed_at: Timestamp | null;
  s1_verdict: Verdict | null;
  s1_category: string | null;
  s2_verdict: Verdict | null;
  s2_category: string | null;
  human_verdict: Verdict | null;
  human_category: string | null;
  needed_human: boolean;
}

export interface DB {
  actors: ActorsTable;
  sessions: SessionsTable;
  batteries: BatteriesTable;
  policies: PoliciesTable;
  provider_configs: ProviderConfigsTable;
  pipeline_configs: PipelineConfigsTable;
  connectors: ConnectorsTable;
  connector_action_modes: ConnectorActionModesTable;
  authors: AuthorsTable;
  ingest_events: IngestEventsTable;
  comments: CommentsTable;
  labels: LabelsTable;
  assessments: AssessmentsTable;
  decisions: DecisionsTable;
  review_items: ReviewItemsTable;
  actions: ActionsTable;
  audit_log: AuditLogTable;
  dataset_exports: DatasetExportsTable;
  dataset_items: DatasetItemsTable;
  evaluations: EvaluationsTable;
  comment_outcomes: CommentOutcomesView;
}

export const SYSTEM_ACTOR_ID = 1;

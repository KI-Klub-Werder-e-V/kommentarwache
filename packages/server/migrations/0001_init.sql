-- kommentarwache initial schema.
-- Evidence tables (assessments, decisions, audit_log) are insert-only, enforced by trigger.
-- Config tables (batteries, policies, provider_configs, pipeline_configs) are immutable versions:
-- a change is a new row that gets activated.

create table actors (
  id bigint generated always as identity primary key,
  type text not null check (type in ('system', 'moderator', 'agent')),
  name text not null,
  email text unique,
  password_hash text,
  token_hash text unique,
  scopes text[] not null default '{}',
  owner_actor_id bigint references actors (id),
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- id 1 is the pipeline itself: every automatic decision is attributed to it.
insert into actors (type, name) values ('system', 'pipeline');

create table sessions (
  id_hash text primary key,
  actor_id bigint not null references actors (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table batteries (
  id bigint generated always as identity primary key,
  name text not null,
  version int not null,
  questions jsonb not null,
  -- which pure routing function turns this battery's answers into a verdict
  mapper text not null,
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table policies (
  id bigint generated always as identity primary key,
  name text not null,
  version int not null,
  spec jsonb not null,
  created_by bigint references actors (id),
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table provider_configs (
  id bigint generated always as identity primary key,
  name text not null unique,
  kind text not null check (kind in ('systemone', 'ollama_guard', 'llm_judge', 'openai_moderation', 'import')),
  base_url text,
  model text,
  battery_id bigint references batteries (id),
  params jsonb not null default '{}',
  calibration jsonb not null default '{}',
  is_local boolean not null default false,
  created_at timestamptz not null default now()
);

create table pipeline_configs (
  id bigint generated always as identity primary key,
  version int not null unique,
  s1_primary bigint references provider_configs (id),
  s1_parallel bigint[] not null default '{}',
  s1_combiner text not null default 'primary_only' check (s1_combiner in ('primary_only', 'all_agree_else_unsure')),
  s2_primary bigint references provider_configs (id),
  shadows bigint[] not null default '{}',
  policy_id bigint references policies (id),
  activated_at timestamptz,
  activated_by bigint references actors (id),
  deactivated_at timestamptz,
  created_at timestamptz not null default now()
);

create table connectors (
  id bigint generated always as identity primary key,
  kind text not null,
  name text not null unique,
  config jsonb not null default '{}',
  -- credentials, encrypted with KW_SECRET_KEY; never stored in config
  secrets_enc bytea,
  capabilities text[] not null default '{}',
  -- platforms like Telegram (48 h) and Twitch (6 h) only allow deletion for a while
  action_window_seconds int,
  cursor jsonb not null default '{}',
  enabled boolean not null default true,
  breaker_open_at timestamptz,
  created_at timestamptz not null default now()
);

create table connector_action_modes (
  connector_id bigint not null references connectors (id) on delete cascade,
  action_type text not null check (action_type in ('hide', 'delete', 'ban')),
  mode text not null check (mode in ('off', 'dry_run', 'propose', 'auto')),
  max_per_hour int,
  primary key (connector_id, action_type)
);

create table authors (
  id bigint generated always as identity primary key,
  connector_id bigint not null references connectors (id),
  platform_author_id text not null,
  display_name text,
  allowlisted boolean not null default false,
  banned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (connector_id, platform_author_id)
);

create table ingest_events (
  id bigint generated always as identity primary key,
  connector_id bigint not null references connectors (id),
  dedupe_key text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connector_id, dedupe_key)
);

create table comments (
  id bigint generated always as identity primary key,
  connector_id bigint not null references connectors (id),
  platform_comment_id text not null,
  author_id bigint references authors (id),
  parent_platform_id text,
  thread_ref text,
  permalink text,
  text text not null,
  content_hash text not null,
  -- bumped when the platform reports an edit; assessments and decisions carry the revision
  revision int not null default 1,
  lang text,
  -- what a model may see besides the text: parent post, parent comment, platform
  context jsonb not null default '{}',
  platform_created_at timestamptz,
  ingested_at timestamptz not null default now(),
  is_backfill boolean not null default false,
  state text not null check (state in ('s1_pending', 's2_pending', 'human_pending', 'closed')),
  state_deadline_at timestamptz,
  pipeline_config_id bigint references pipeline_configs (id),
  final_verdict text check (final_verdict in ('ok', 'unsure', 'violation')),
  final_category text,
  final_stage text check (final_stage in ('s1', 's2', 'human')),
  closed_at timestamptz,
  text_redacted_at timestamptz,
  unique (connector_id, platform_comment_id)
);
create index comments_state_idx on comments (state, state_deadline_at);
create index comments_ingested_idx on comments (ingested_at);

-- Labels from outside the pipeline: the prototype's expected verdicts, a blind second
-- reviewer, or an export's gold set. Used by the eval harness, never by routing.
create table labels (
  id bigint generated always as identity primary key,
  comment_id bigint not null references comments (id),
  source text not null,
  verdict text not null check (verdict in ('ok', 'unsure', 'violation')),
  category text,
  sentiment text,
  note text,
  created_at timestamptz not null default now(),
  unique (comment_id, source)
);

create table assessments (
  id bigint generated always as identity primary key,
  comment_id bigint not null references comments (id),
  revision int not null,
  provider_config_id bigint not null references provider_configs (id),
  stage text not null check (stage in ('s1', 's2')),
  role text not null check (role in ('primary', 'parallel', 'shadow')),
  status text not null check (status in ('ok', 'error', 'timeout')),
  model_version text,
  battery_id bigint references batteries (id),
  -- the typed answers with probabilities, in the System One answer shape
  answers jsonb,
  -- whatever else the provider returned, for debugging
  raw jsonb,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 8),
  error text,
  created_at timestamptz not null default now(),
  unique (comment_id, revision, provider_config_id, stage)
);

create table decisions (
  id bigint generated always as identity primary key,
  comment_id bigint not null references comments (id),
  revision int not null,
  stage text not null check (stage in ('s1', 's2', 'human')),
  -- false for shadow providers and policy replays: recorded, never acted on
  effective boolean not null default true,
  verdict text not null check (verdict in ('ok', 'unsure', 'violation')),
  category text not null,
  reasons jsonb not null default '[]',
  policy_id bigint references policies (id),
  provider_config_id bigint references provider_configs (id),
  assessment_ids bigint[] not null default '{}',
  actor_id bigint not null references actors (id),
  via text not null check (via in ('pipeline', 'dashboard', 'api', 'mcp', 'cli', 'replay')),
  overrides_decision_id bigint references decisions (id),
  replay_run_id bigint,
  note text,
  created_at timestamptz not null default now()
);
create unique index decisions_one_effective_per_stage
  on decisions (comment_id, revision, stage) where effective and stage in ('s1', 's2');
create index decisions_comment_idx on decisions (comment_id, created_at);

create table review_items (
  id bigint generated always as identity primary key,
  comment_id bigint not null references comments (id),
  reason text not null check (reason in (
    'both_unsure', 'stage_disagree', 's2_timeout', 'provider_failure', 'action_failed',
    'unsupported_action', 'audit_sample', 'shadow_diff', 'proposed_action'
  )),
  priority int not null default 0,
  created_at timestamptz not null default now(),
  claimed_by bigint references actors (id),
  claimed_at timestamptz,
  first_viewed_at timestamptz,
  resolved_at timestamptz,
  resolution_decision_id bigint references decisions (id)
);
create unique index review_items_open_once on review_items (comment_id) where resolved_at is null;

create table actions (
  id bigint generated always as identity primary key,
  connector_id bigint not null references connectors (id),
  comment_id bigint references comments (id),
  author_id bigint references authors (id),
  action_type text not null check (action_type in ('hide', 'unhide', 'delete', 'ban', 'unban', 'hold', 'approve')),
  mode text not null check (mode in ('auto', 'dry_run', 'proposed', 'manual')),
  -- which policy rule produced it, for the log
  rule text,
  decision_id bigint references decisions (id),
  actor_id bigint not null references actors (id),
  via text not null,
  state text not null check (state in ('planned', 'executing', 'succeeded', 'failed', 'simulated', 'cancelled')),
  reversible boolean not null,
  idempotency_key text not null unique,
  execute_after timestamptz,
  attempts int not null default 0,
  platform_response jsonb,
  error text,
  undoes_action_id bigint references actions (id),
  undone_at timestamptz,
  -- deletes cannot be undone; a wrong one is marked overturned so it still counts as an error
  overturned_at timestamptz,
  overturned_by_decision_id bigint references decisions (id),
  created_at timestamptz not null default now(),
  executed_at timestamptz
);
create index actions_comment_idx on actions (comment_id);
create index actions_state_idx on actions (state, execute_after);

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id bigint references actors (id),
  via text,
  event text not null,
  subject_type text,
  subject_id bigint,
  payload jsonb not null default '{}',
  prev_hash text,
  hash text not null
);

create table dataset_exports (
  id bigint generated always as identity primary key,
  battery_id bigint references batteries (id),
  filter jsonb not null default '{}',
  sha256 text,
  counts jsonb not null default '{}',
  created_by bigint references actors (id),
  created_at timestamptz not null default now()
);

create table dataset_items (
  export_id bigint not null references dataset_exports (id) on delete cascade,
  comment_id bigint not null references comments (id),
  split text not null check (split in ('train', 'calib', 'test')),
  primary key (export_id, comment_id)
);

create table evaluations (
  id bigint generated always as identity primary key,
  provider_config_id bigint references provider_configs (id),
  export_id bigint references dataset_exports (id),
  kind text not null,
  metrics jsonb not null default '{}',
  gate_passed boolean,
  decided_by bigint references actors (id),
  created_at timestamptz not null default now()
);

-- Insert-only enforcement for evidence tables.
create function reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is insert-only; insert a new row that overrides the old one', tg_table_name;
end
$$;
create trigger assessments_insert_only before update or delete on assessments
  for each row execute function reject_mutation();
create trigger decisions_insert_only before update or delete on decisions
  for each row execute function reject_mutation();
create trigger audit_log_insert_only before update or delete on audit_log
  for each row execute function reject_mutation();

-- One row per comment at its current revision with every stage's verdict side by side.
-- All analytics are simple queries on this view.
create view comment_outcomes as
select
  c.id as comment_id,
  c.connector_id,
  c.ingested_at,
  c.revision,
  c.state,
  c.final_verdict,
  c.final_category,
  c.final_stage,
  c.closed_at,
  s1.verdict as s1_verdict,
  s1.category as s1_category,
  s2.verdict as s2_verdict,
  s2.category as s2_category,
  h.verdict as human_verdict,
  h.category as human_category,
  exists (
    select 1 from review_items r where r.comment_id = c.id and r.reason <> 'audit_sample'
  ) as needed_human
from comments c
left join decisions s1
  on s1.comment_id = c.id and s1.revision = c.revision and s1.stage = 's1' and s1.effective
left join decisions s2
  on s2.comment_id = c.id and s2.revision = c.revision and s2.stage = 's2' and s2.effective
left join lateral (
  select d.verdict, d.category
  from decisions d
  where d.comment_id = c.id and d.revision = c.revision and d.stage = 'human' and d.effective
  order by d.created_at desc
  limit 1
) h on true;

export interface Migration {
    readonly version: number;
    readonly sql: string;
}

/**
 * Schema history. Within a major version every migration only adds tables, columns or indexes, never renames
 * or drops, so rolling the app bundle back never requires rolling the database back.
 */
export const MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        sql: `
create table projects (
    id text primary key,
    name text not null,
    path text not null unique,
    added_at integer not null,
    last_opened_at integer,
    trusted integer not null default 0,
    defaults_json text
);

create table threads (
    id text primary key,
    project_id text not null,
    title text not null,
    created_at integer not null,
    updated_at integer not null,
    status text not null,
    needs_review integer not null default 0,
    unread integer not null default 0,
    engine text not null,
    model_json text,
    mode text not null,
    effort text not null,
    location_json text not null,
    pinned integer not null default 0,
    archived integer not null default 0,
    last_seq integer not null default 0,
    turns integer not null default 0,
    cost_amount real,
    cost_currency text,
    context_json text,
    session_id text,
    session_prompt text,
    extra_json text
);
create index threads_by_project on threads (project_id, updated_at desc);

create table turns (
    thread_id text not null,
    turn_id text not null,
    started_at integer not null,
    ended_at integer,
    status text not null,
    checkpoint_before text,
    checkpoint_after text,
    files_json text,
    primary key (thread_id, turn_id)
);

create table usage_events (
    id text primary key,
    ts integer not null,
    project_id text,
    thread_id text,
    turn_id text,
    agent_path text not null default 'main',
    agent_id text,
    task_id text,
    workflow_run_id text,
    role text,
    tier text,
    template text,
    engine text not null,
    provider text not null,
    channel text,
    region text,
    model text not null,
    input_tokens integer not null default 0,
    cached_tokens integer not null default 0,
    cache_write_tokens integer not null default 0,
    output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0,
    requests integer not null default 1,
    server_tool_calls_json text,
    latency_ms integer not null default 0,
    ttft_ms integer,
    cost_amount real,
    cost_currency text,
    cost_table text,
    cost_period text,
    cost_complete integer not null default 1,
    status text not null,
    error_class text,
    stop_reason text,
    source text not null
);
create index usage_by_ts on usage_events (ts);
create index usage_by_thread on usage_events (thread_id, ts);
create index usage_by_project on usage_events (project_id, ts);

create table settings (
    key text primary key,
    value_json text not null
);

create table connections (
    id text primary key,
    preset_id text not null,
    name text not null,
    base_url text,
    has_key integer not null default 0,
    enabled integer not null default 1,
    models_json text,
    status_json text,
    created_at integer not null,
    updated_at integer not null
);

create table rules (
    id text primary key,
    scope text not null,
    project_id text,
    tool text not null,
    pattern text not null,
    decision text not null,
    created_at integer not null,
    note text
);

create virtual table thread_text using fts5 (
    thread_id unindexed,
    turn_id unindexed,
    title,
    body,
    tokenize = 'trigram'
);
`,
    },
    {
        // Agent-team runs (06 §9): the run, a board snapshot and both ledgers per row, plus the board events
        // after the snapshot, so a run is restored after a restart without redoing finished tasks.
        version: 2,
        sql: `
create table team_runs (
    id text primary key,
    project_id text,
    org_id text not null,
    goal text not null,
    status text not null,
    phase text not null,
    created_at integer not null,
    updated_at integer not null,
    run_json text not null,
    board_json text,
    board_seq integer not null default 0,
    task_ledger_json text,
    progress_json text,
    host_json text
);
create index team_runs_by_project on team_runs (project_id, created_at desc);

create table team_board_events (
    run_id text not null,
    seq integer not null,
    ts integer not null,
    task_id text not null,
    type text not null,
    event_json text not null,
    primary key (run_id, seq)
);
`,
    },
];

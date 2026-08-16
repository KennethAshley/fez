-- fez operator tables (Supabase / any Postgres)

-- Relay durability (EventStore): every accepted non-ephemeral event.
create table if not exists fez_events (
  id text primary key,
  kind integer not null,
  pubkey text not null,
  created_at bigint not null,
  content text not null,
  tags jsonb not null,
  sig text not null
);
create index if not exists fez_events_kind on fez_events (kind);
create index if not exists fez_events_pubkey on fez_events (pubkey);
create index if not exists fez_events_created on fez_events (created_at);

-- Indexer state (IndexStore): derived thread stats.
create table if not exists fez_thread_stats (
  root_id text primary key,
  channel_id text not null,
  community_id text not null,
  reply_count integer not null,
  last_reply_at bigint not null,
  participants jsonb not null
);

-- Ban list consulted by the ingest policy.
create table if not exists fez_banned_pubkeys (
  pubkey text primary key,
  reason text,
  banned_at timestamptz default now()
);

create table public.fez_skill_installs (
  id bigint generated always as identity primary key,
  skill_name text not null check (char_length(skill_name) between 1 and 64),
  listing_author text not null check (listing_author ~ '^[0-9a-f]{64}$'),
  installer text not null check (installer ~ '^[0-9a-f]{64}$'),
  event_id text not null check (event_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (skill_name, listing_author, installer)
);
alter table public.fez_skill_installs enable row level security;
create policy "anyone can read installs"
  on public.fez_skill_installs for select using (true);
-- no write policies: anon writes impossible; the edge function uses the
-- service role after signature verification.
create view public.fez_skill_install_counts
  with (security_invoker = true) as
  select skill_name, listing_author, count(*)::int as installs
  from public.fez_skill_installs
  group by skill_name, listing_author;

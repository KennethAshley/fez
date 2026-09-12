create table public.fez_email_signups (
  email text primary key check (
    char_length(email) between 3 and 254
    and email = lower(btrim(email))
  ),
  created_at timestamptz not null default now()
);

alter table public.fez_email_signups enable row level security;
revoke all on public.fez_email_signups from public, anon, authenticated;
grant select, insert on public.fez_email_signups to service_role;
-- No public policies. Only the edge function can add addresses; duplicates
-- keep the original signup date. Export privately through the dashboard.

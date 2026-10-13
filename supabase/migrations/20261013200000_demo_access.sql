-- Shared access codes and spend cap for the live demo tools
-- (api-error-explainer and sso-assistant). Both tools draw from one budget.
--
-- Rules enforced here, atomically, before any Claude call is made:
--   * every request needs a valid, unrevoked access code
--   * all codes together can spend at most demo_settings.global_cap_usd ($15)
--   * one code can spend at most its own cap_usd ($5 by default)
--   * one code can make at most demo_settings.hourly_limit requests per hour
-- A request reserves its worst-case cost first and settles to the real cost after,
-- so the caps can't be overshot by parallel requests.
--
-- RLS is on with no policies, and every function is executable by service_role only,
-- so the public anon key can't read codes, read usage, or spend money.

create table if not exists public.demo_settings (
  id             int primary key default 1 check (id = 1),
  global_cap_usd numeric(10,4) not null default 15,
  hourly_limit   int not null default 30,
  enabled        boolean not null default true
);
insert into public.demo_settings (id) values (1) on conflict do nothing;

create table if not exists public.demo_access_codes (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  code_hash  text not null unique,
  cap_usd    numeric(10,4) not null default 5,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.demo_usage (
  id            bigint generated always as identity primary key,
  code_id       uuid not null references public.demo_access_codes(id),
  tool          text not null check (tool in ('api-error-explainer', 'sso-assistant')),
  ticket_id     text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'reserved' check (status in ('reserved', 'done', 'failed')),
  reserved_usd  numeric(10,6) not null,
  cost_usd      numeric(10,6),
  model         text,
  input_tokens  int,
  output_tokens int
);
create index if not exists demo_usage_code_started on public.demo_usage (code_id, started_at);

alter table public.demo_settings     enable row level security;
alter table public.demo_access_codes enable row level security;
alter table public.demo_usage        enable row level security;

-- What a row counts against the caps: real cost once settled, the reservation until then.
-- Failed requests that never reached Claude settle to 0.
create or replace function public.demo_row_cost(u public.demo_usage)
returns numeric language sql immutable set search_path = '' as $$
  select coalesce(u.cost_usd, case when u.status = 'reserved' then u.reserved_usd else 0 end)
$$;

-- Create a code for one person. Returns the plaintext code once; only its hash is stored.
create or replace function public.demo_create_code(p_label text, p_cap_usd numeric default 5)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw  text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  code text;
begin
  -- 16 hex characters from two random UUIDs, shown as xxxx-xxxx-xxxx-xxxx
  code := substr(raw, 1, 4) || '-' || substr(raw, 13, 4) || '-' || substr(raw, 33, 4) || '-' || substr(raw, 45, 4);
  insert into public.demo_access_codes (label, code_hash, cap_usd)
  values (p_label, encode(sha256(convert_to(code, 'UTF8')), 'hex'), p_cap_usd);
  return code;
end $$;

create or replace function public.demo_revoke_code(p_label text)
returns boolean language sql security definer set search_path = '' as $$
  update public.demo_access_codes set revoked_at = now()
  where label = p_label and revoked_at is null
  returning true
$$;

-- Check a code without spending anything (used when someone signs in on the page).
create or replace function public.demo_check_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.demo_access_codes;
  s public.demo_settings;
  spent_code numeric; spent_all numeric;
begin
  select * into s from public.demo_settings where id = 1;
  select * into c from public.demo_access_codes
   where code_hash = encode(sha256(convert_to(trim(p_code), 'UTF8')), 'hex') and revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  select coalesce(sum(public.demo_row_cost(u)), 0) into spent_code from public.demo_usage u where u.code_id = c.id;
  select coalesce(sum(public.demo_row_cost(u)), 0) into spent_all  from public.demo_usage u;
  return jsonb_build_object('ok', s.enabled, 'reason', case when s.enabled then null else 'disabled' end,
    'label', c.label,
    'remaining_usd', round(greatest(0, least(c.cap_usd - spent_code, s.global_cap_usd - spent_all)), 2));
end $$;

-- Reserve the worst-case cost of one request. Returns a request id to settle later.
create or replace function public.demo_begin(p_code text, p_tool text, p_max_cost_usd numeric, p_ticket_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.demo_settings;
  c public.demo_access_codes;
  spent_code numeric; spent_all numeric; recent int; new_id bigint;
begin
  -- Lock the settings row so concurrent requests check the caps one at a time.
  select * into s from public.demo_settings where id = 1 for update;
  if not s.enabled then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;

  select * into c from public.demo_access_codes
   where code_hash = encode(sha256(convert_to(trim(p_code), 'UTF8')), 'hex') and revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;

  select count(*) into recent from public.demo_usage u
   where u.code_id = c.id and u.started_at > now() - interval '1 hour';
  if recent >= s.hourly_limit then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;

  select coalesce(sum(public.demo_row_cost(u)), 0) into spent_code from public.demo_usage u where u.code_id = c.id;
  if spent_code + p_max_cost_usd > c.cap_usd then return jsonb_build_object('ok', false, 'reason', 'code_cap'); end if;

  select coalesce(sum(public.demo_row_cost(u)), 0) into spent_all from public.demo_usage u;
  if spent_all + p_max_cost_usd > s.global_cap_usd then return jsonb_build_object('ok', false, 'reason', 'global_cap'); end if;

  insert into public.demo_usage (code_id, tool, ticket_id, reserved_usd)
  values (c.id, p_tool, left(p_ticket_id, 40), p_max_cost_usd)
  returning id into new_id;
  return jsonb_build_object('ok', true, 'request_id', new_id, 'label', c.label);
end $$;

-- Settle a request to its real cost (0 if Claude was never reached).
create or replace function public.demo_finish(p_request_id bigint, p_ok boolean, p_cost_usd numeric,
                                              p_model text default null, p_input_tokens int default null, p_output_tokens int default null)
returns void language sql security definer set search_path = '' as $$
  update public.demo_usage
     set status = case when p_ok then 'done' else 'failed' end,
         cost_usd = greatest(0, coalesce(p_cost_usd, 0)),
         finished_at = now(), model = p_model,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens
   where id = p_request_id and status = 'reserved'
$$;

-- Keeps the free Supabase project from pausing (called by a daily cron).
create or replace function public.demo_ping()
returns int language sql security definer set search_path = '' as $$ select 1 $$;

-- Who has used what. Read it in the SQL editor: select * from public.demo_usage_by_code;
create or replace view public.demo_usage_by_code with (security_invoker = true) as
select c.label,
       c.revoked_at is not null                               as revoked,
       count(u.id)                                            as requests,
       count(u.id) filter (where u.tool = 'api-error-explainer') as explainer_requests,
       count(u.id) filter (where u.tool = 'sso-assistant')       as sso_requests,
       round(coalesce(sum(public.demo_row_cost(u)), 0), 4)    as spent_usd,
       c.cap_usd,
       max(u.started_at)                                      as last_used
  from public.demo_access_codes c
  left join public.demo_usage u on u.code_id = c.id
 group by c.id;

revoke all on public.demo_settings, public.demo_access_codes, public.demo_usage, public.demo_usage_by_code from anon, authenticated;
revoke execute on function public.demo_row_cost(public.demo_usage), public.demo_create_code(text, numeric), public.demo_revoke_code(text),
  public.demo_check_code(text), public.demo_begin(text, text, numeric, text),
  public.demo_finish(bigint, boolean, numeric, text, int, int), public.demo_ping() from public, anon, authenticated;
grant execute on function public.demo_check_code(text), public.demo_begin(text, text, numeric, text),
  public.demo_finish(bigint, boolean, numeric, text, int, int), public.demo_ping(),
  public.demo_create_code(text, numeric), public.demo_revoke_code(text) to service_role;

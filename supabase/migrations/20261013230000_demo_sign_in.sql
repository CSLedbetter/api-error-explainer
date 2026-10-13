-- Replace access codes with Supabase Auth sign-in (Google or email) plus manual approval.
-- New sign-ins start as 'pending'. Casey approves them on /admin. Approved users get their own
-- $5 budget inside the shared $15 cap, enforced the same way as before (reserve, then settle).
-- Calls are logged in a new demo_calls table; the access-code objects from the first migration
-- are no longer used and nothing grants them to the public.
--
-- The admin email is set outside this file so it isn't published:
--   update public.demo_settings set admin_email = '<email>';

alter table public.demo_settings add column if not exists admin_email text;

create table if not exists public.demo_users (
  user_id      uuid primary key references auth.users(id),
  email        text,
  full_name    text,
  provider     text,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  cap_usd      numeric(10,4) not null default 5,
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  last_seen_at timestamptz,
  note         text
);
alter table public.demo_users enable row level security;

create table if not exists public.demo_calls (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.demo_users(user_id),
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
create index if not exists demo_calls_user_started on public.demo_calls (user_id, started_at);
alter table public.demo_calls enable row level security;

-- What a call counts against the caps: real cost once settled, the reservation until then.
create or replace function public.demo_call_cost(c public.demo_calls)
returns numeric language sql immutable set search_path = '' as $$
  select coalesce(c.cost_usd, case when c.status = 'reserved' then c.reserved_usd else 0 end)
$$;

-- Every new auth user gets a pending row. The admin is approved automatically.
create or replace function public.demo_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare admin text;
begin
  select lower(admin_email) into admin from public.demo_settings where id = 1;
  insert into public.demo_users (user_id, email, full_name, provider, status, cap_usd, decided_at)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_app_meta_data->>'provider',
    case when lower(new.email) = admin then 'approved' else 'pending' end,
    case when lower(new.email) = admin then 15 else 5 end,
    case when lower(new.email) = admin then now() end)
  on conflict (user_id) do nothing;
  return new;
end $$;
create or replace trigger demo_on_auth_user_created after insert on auth.users
  for each row execute function public.demo_handle_new_user();

-- Status for the signed-in visitor (called by the server with an id it verified from the token).
create or replace function public.demo_user_status(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.demo_users; s public.demo_settings; spent_user numeric; spent_all numeric;
begin
  select * into s from public.demo_settings where id = 1;
  update public.demo_users set last_seen_at = now() where user_id = p_user_id returning * into u;
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  select coalesce(sum(public.demo_call_cost(c)), 0) into spent_user from public.demo_calls c where c.user_id = u.user_id;
  select coalesce(sum(public.demo_call_cost(c)), 0) into spent_all from public.demo_calls c;
  return jsonb_build_object(
    'status', case when not s.enabled and u.status = 'approved' then 'disabled' else u.status end,
    'email', u.email, 'name', u.full_name,
    'is_admin', lower(u.email) = lower(s.admin_email),
    'remaining_usd', round(greatest(0, least(u.cap_usd - spent_user, s.global_cap_usd - spent_all)), 2));
end $$;

-- Reserve the worst-case cost of one request for an approved user.
create or replace function public.demo_begin_user(p_user_id uuid, p_tool text, p_max_cost_usd numeric, p_ticket_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.demo_settings; u public.demo_users; spent_user numeric; spent_all numeric; recent int; new_id bigint;
begin
  select * into s from public.demo_settings where id = 1 for update;
  if not s.enabled then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  select * into u from public.demo_users where user_id = p_user_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if u.status = 'pending' then return jsonb_build_object('ok', false, 'reason', 'pending'); end if;
  if u.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  select count(*) into recent from public.demo_calls c where c.user_id = u.user_id and c.started_at > now() - interval '1 hour';
  if recent >= s.hourly_limit then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  select coalesce(sum(public.demo_call_cost(c)), 0) into spent_user from public.demo_calls c where c.user_id = u.user_id;
  if spent_user + p_max_cost_usd > u.cap_usd then return jsonb_build_object('ok', false, 'reason', 'user_cap'); end if;
  select coalesce(sum(public.demo_call_cost(c)), 0) into spent_all from public.demo_calls c;
  if spent_all + p_max_cost_usd > s.global_cap_usd then return jsonb_build_object('ok', false, 'reason', 'global_cap'); end if;
  insert into public.demo_calls (user_id, tool, ticket_id, reserved_usd)
  values (u.user_id, p_tool, left(p_ticket_id, 40), p_max_cost_usd) returning id into new_id;
  return jsonb_build_object('ok', true, 'request_id', new_id);
end $$;

-- Settle a call to its real cost (0 if Claude was never reached).
create or replace function public.demo_finish_call(p_request_id bigint, p_ok boolean, p_cost_usd numeric,
                                                   p_model text default null, p_input_tokens int default null, p_output_tokens int default null)
returns void language sql security definer set search_path = '' as $$
  update public.demo_calls
     set status = case when p_ok then 'done' else 'failed' end,
         cost_usd = greatest(0, coalesce(p_cost_usd, 0)),
         finished_at = now(), model = p_model,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens
   where id = p_request_id and status = 'reserved'
$$;

-- Admin: everyone who has signed in, with usage. The server only calls this for the admin.
create or replace function public.demo_admin_list()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select jsonb_build_object('global_cap_usd', global_cap_usd, 'enabled', enabled, 'hourly_limit', hourly_limit) from public.demo_settings where id = 1),
    'spent_total_usd', (select round(coalesce(sum(public.demo_call_cost(c)), 0), 4) from public.demo_calls c),
    'users', coalesce((select jsonb_agg(row_to_json(r) order by r.status = 'pending' desc, r.requested_at desc) from (
      select u.user_id, u.email, u.full_name, u.provider, u.status, u.cap_usd, u.requested_at, u.decided_at, u.last_seen_at,
             count(c.id) as requests,
             count(c.id) filter (where c.tool = 'api-error-explainer') as explainer_requests,
             count(c.id) filter (where c.tool = 'sso-assistant') as sso_requests,
             round(coalesce(sum(public.demo_call_cost(c)), 0), 4) as spent_usd,
             max(c.started_at) as last_used
        from public.demo_users u left join public.demo_calls c on c.user_id = u.user_id
       group by u.user_id) r), '[]'::jsonb))
$$;

create or replace function public.demo_admin_set(p_user_id uuid, p_status text, p_cap_usd numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.demo_users;
begin
  if p_status not in ('pending', 'approved', 'revoked') then raise exception 'bad status'; end if;
  update public.demo_users set status = p_status, decided_at = now(), cap_usd = coalesce(p_cap_usd, cap_usd)
   where user_id = p_user_id returning * into u;
  return jsonb_build_object('ok', found, 'status', u.status, 'cap_usd', u.cap_usd);
end $$;

create or replace function public.demo_admin_toggle(p_enabled boolean)
returns boolean language sql security definer set search_path = '' as $$
  update public.demo_settings set enabled = p_enabled where id = 1 returning enabled
$$;

-- Who has used what. In the SQL editor: select * from public.demo_usage_by_user;
create or replace view public.demo_usage_by_user with (security_invoker = true) as
select u.email, u.full_name, u.status, count(c.id) as requests,
       round(coalesce(sum(public.demo_call_cost(c)), 0), 4) as spent_usd, u.cap_usd, max(c.started_at) as last_used
  from public.demo_users u left join public.demo_calls c on c.user_id = u.user_id
 group by u.user_id;

revoke all on public.demo_users, public.demo_calls, public.demo_usage_by_user from anon, authenticated;
revoke execute on function public.demo_call_cost(public.demo_calls), public.demo_handle_new_user(), public.demo_user_status(uuid),
  public.demo_begin_user(uuid, text, numeric, text), public.demo_finish_call(bigint, boolean, numeric, text, int, int),
  public.demo_admin_list(), public.demo_admin_set(uuid, text, numeric), public.demo_admin_toggle(boolean) from public, anon, authenticated;
grant execute on function public.demo_user_status(uuid), public.demo_begin_user(uuid, text, numeric, text),
  public.demo_finish_call(bigint, boolean, numeric, text, int, int),
  public.demo_admin_list(), public.demo_admin_set(uuid, text, numeric), public.demo_admin_toggle(boolean) to service_role;

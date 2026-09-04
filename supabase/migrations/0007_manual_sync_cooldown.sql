-- ============================================================================
-- 0007_manual_sync_cooldown.sql
-- TD's Only League — league-wide cooldown for manual sync triggers
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0006 have been run.
--
-- WHY
-- ----------------------------------------------------------------------------
-- The Commish page can hand-trigger the Tank01 sync Edge Functions. Tank01
-- Pro is 1,000 calls/DAY (see the CALL BUDGET section of 0004_cron.sql), and
-- the scheduled cadences already assume nothing else is spending that budget.
-- A button anyone can mash is the obvious way to blow through it, so a manual
-- trigger is limited to ONE PER HOUR ACROSS THE WHOLE LEAGUE — not per user
-- and not per source. Once any commissioner triggers any sync, every manual
-- trigger is unavailable to everyone until the hour is up.
--
-- The limit is enforced HERE, in the database, rather than in the UI or the
-- server action: the window has to be shared across users, sessions and app
-- instances, and two commissioners clicking at the same moment must not both
-- get through (claim_manual_sync takes an advisory lock for exactly that).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- manual_sync_runs
-- One row per manual trigger that was actually allowed through. Append-only,
-- except that the server action deletes its own row (release_manual_sync)
-- when the Edge Function call fails — a sync that never ran should not burn
-- the league's hour.
-- ----------------------------------------------------------------------------
create table if not exists public.manual_sync_runs (
  id bigserial primary key,
  source text not null check (source in ('players', 'schedule', 'scores', 'locks')),
  triggered_by uuid references public.profiles (id) on delete set null,
  triggered_at timestamptz not null default now()
);

comment on table public.manual_sync_runs is
  'Manual (Commish page) sync triggers. The newest row gates the league-wide '
  'one-per-hour cooldown — see claim_manual_sync().';

create index if not exists manual_sync_runs_triggered_at_idx
  on public.manual_sync_runs (triggered_at desc);

-- ----------------------------------------------------------------------------
-- manual_sync_cooldown()
-- Single source of truth for the window length. Referenced by
-- claim_manual_sync() below; the UI mirrors it as MANUAL_SYNC_COOLDOWN_MS in
-- src/lib/db/sync.ts (display only — this function is what actually decides).
-- ----------------------------------------------------------------------------
create or replace function public.manual_sync_cooldown()
returns interval
language sql
immutable
as $$
  select interval '1 hour';
$$;

-- ----------------------------------------------------------------------------
-- claim_manual_sync(source)
-- Atomically claims the league's next manual sync slot. Returns claimed =
-- false (rather than raising) when the cooldown is still running, so the
-- caller can show "available again in Xm" instead of an error.
--
-- security definer because manual_sync_runs has no INSERT policy: the ONLY
-- way to write a row is through this function, which does its own
-- commissioner check. That keeps the cooldown from being sidestepped by a
-- direct insert/delete from a logged-in client.
-- ----------------------------------------------------------------------------
create or replace function public.claim_manual_sync(p_source text)
returns table (
  claimed boolean,
  run_id bigint,
  available_at timestamptz,
  blocked_by text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_last public.manual_sync_runs%rowtype;
  v_new_id bigint;
begin
  if not public.is_commissioner(v_uid) then
    raise exception 'Commissioner access required to trigger a sync.'
      using errcode = '42501';
  end if;

  -- Serializes concurrent claims: without this, two commissioners clicking
  -- in the same second would both read an expired window and both fire.
  -- Transaction-scoped, so it is released when this statement commits.
  perform pg_advisory_xact_lock(hashtext('manual_sync_cooldown'));

  select * into v_last
    from public.manual_sync_runs
   order by triggered_at desc
   limit 1;

  if v_last.id is not null
     and v_last.triggered_at > now() - public.manual_sync_cooldown() then
    return query
      select false,
             null::bigint,
             v_last.triggered_at + public.manual_sync_cooldown(),
             (select display_name from public.profiles where id = v_last.triggered_by);
    return;
  end if;

  insert into public.manual_sync_runs (source, triggered_by)
  values (p_source, v_uid)
  returning id into v_new_id;

  return query
    select true, v_new_id, now() + public.manual_sync_cooldown(), null::text;
end;
$$;

comment on function public.claim_manual_sync is
  'Claims the league-wide manual sync slot. Returns claimed=false plus '
  'available_at when the one-per-hour cooldown is still running.';

-- ----------------------------------------------------------------------------
-- release_manual_sync(run_id)
-- Undoes a claim whose Edge Function call did not actually go through, so a
-- failed trigger does not cost the league an hour. Deliberately limited to
-- the caller's own claim, and only while it is still the newest one — it
-- cannot be used to clear someone else's cooldown.
-- ----------------------------------------------------------------------------
create or replace function public.release_manual_sync(p_run_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not public.is_commissioner(v_uid) then
    raise exception 'Commissioner access required.' using errcode = '42501';
  end if;

  delete from public.manual_sync_runs
   where id = p_run_id
     and triggered_by = v_uid
     and id = (select max(id) from public.manual_sync_runs);
end;
$$;

comment on function public.release_manual_sync is
  'Deletes the caller''s own just-made claim when the sync call failed, so a '
  'failed trigger does not burn the cooldown.';

-- ----------------------------------------------------------------------------
-- RLS: everyone authenticated can SEE the cooldown (the Commish page renders
-- "available again in Xm" from it). Nobody gets a direct INSERT / UPDATE /
-- DELETE policy — writes go exclusively through the two security-definer
-- functions above.
-- ----------------------------------------------------------------------------
alter table public.manual_sync_runs enable row level security;

drop policy if exists "manual_sync_runs_select_authenticated" on public.manual_sync_runs;
create policy "manual_sync_runs_select_authenticated"
  on public.manual_sync_runs for select
  to authenticated
  using (true);

grant execute on function public.claim_manual_sync(text) to authenticated;
grant execute on function public.release_manual_sync(bigint) to authenticated;
grant execute on function public.manual_sync_cooldown() to authenticated;

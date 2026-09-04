-- ============================================================================
-- 0008_per_source_sync_cooldown.sql
-- TD's Only League — make the manual sync cooldown PER JOB, not global
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0007_manual_sync_cooldown.sql.
--
-- WHAT CHANGES
-- ----------------------------------------------------------------------------
-- 0007 made one manual sync per hour lock out EVERY job for everyone. In
-- practice that is too blunt: refreshing the player pool should not stop
-- anyone from pulling scores during a game. The hour is now tracked per
-- source, so Players and Scores hold independent windows. It is still
-- league-wide within a source — once anyone triggers Players, Players is
-- unavailable to everyone for an hour.
--
-- The call-budget reasoning from 0007 still holds: two sources times one run
-- per hour is a trivial share of the Tank01 daily allowance.
--
-- Nothing is dropped and no data is lost — manual_sync_runs keeps every row,
-- only the two functions' scoping changes. Re-running is safe.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- claim_manual_sync(source) — now scoped to the source being claimed.
-- The advisory lock is keyed per source too, so a Players claim and a Scores
-- claim don't serialize against each other while still preventing two
-- simultaneous claims of the SAME job.
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

  if p_source is null or p_source not in ('players', 'schedule', 'scores', 'locks') then
    raise exception 'Unknown sync source: %', coalesce(p_source, '<null>')
      using errcode = '22023';
  end if;

  -- Per-source lock: concurrent claims of the same job serialize, different
  -- jobs proceed in parallel.
  perform pg_advisory_xact_lock(hashtext('manual_sync_cooldown:' || p_source));

  select * into v_last
    from public.manual_sync_runs
   where source = p_source
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
  'Claims the manual sync slot FOR ONE SOURCE. League-wide within that '
  'source: returns claimed=false plus available_at while its hour runs.';

-- ----------------------------------------------------------------------------
-- release_manual_sync(run_id) — the "still the newest" guard is now scoped to
-- the row's own source, so releasing a failed Scores claim is not blocked by
-- a Players claim that happened to be made afterwards.
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

  delete from public.manual_sync_runs m
   where m.id = p_run_id
     and m.triggered_by = v_uid
     and m.id = (
       select max(id) from public.manual_sync_runs where source = m.source
     );
end;
$$;

comment on function public.release_manual_sync is
  'Deletes the caller''s own just-made claim for its source when the sync '
  'call failed, so a failed trigger does not burn that job''s cooldown.';

-- ----------------------------------------------------------------------------
-- Verify (each source holds its own hour):
--   select * from public.claim_manual_sync('players');  -- claimed = true
--   select * from public.claim_manual_sync('players');  -- claimed = false
--   select * from public.claim_manual_sync('scores');   -- claimed = true
-- ----------------------------------------------------------------------------

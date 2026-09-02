-- ============================================================================
-- 0004_cron.sql
-- TD's Only League — sync job scheduling via pg_cron + pg_net
--
-- WHAT THIS DOES
-- ----------------------------------------------------------------------------
-- Schedules periodic HTTP POSTs (via pg_net) to the Edge Functions in
-- supabase/functions/. Cadences are sized against the Tank01 (RapidAPI) Pro
-- plan budget of 1,000 calls/DAY — see the CALL BUDGET section below.
--   sync-players  every 6 hours     (roster + injury-status refresh)
--   sync-schedule every 12 hours    (first_kickoff_at + bye weeks)
--   sync-scores   every 30 min, GAME-DAY WINDOWS ONLY (see below)
--   apply-locks   every 5 minutes   (auto-lock rosters at kickoff; DB-only,
--                                    makes no external API calls, so it is
--                                    free and stays frequent)
--
-- CALL BUDGET (why these intervals)
-- ----------------------------------------------------------------------------
-- The old cadences did not fit a 1,000/day cap. sync-players is the worst
-- offender because it makes 1 team-index call + 1 call PER TEAM (32) per run:
--   sync-players  @ */20  -> 72 runs/day x 33 calls = ~2,376 calls/day  (!!)
--   sync-schedule @ */30  -> 48 runs/day
--   sync-scores   @ */10  -> 144 runs/day, x N in-progress games each
-- New cadences, using the ACTUAL Tank01 call counts (measured against the
-- captured responses in reference/tank01/, not estimated):
--   sync-players  @ every 6h  -> 4 runs/day x ~3 paginated calls = ~12/day.
--                    Tank01 returns the whole league from one endpoint
--                    (1000 players/page + nextToken), so the old per-team
--                    roster fan-out is gone entirely.
--   sync-schedule @ every 12h -> 2 runs/day x 2 calls = 4/day
--                    (getNFLGamesForWeek + getNFLTeams for bye weeks).
--   sync-scores   -> 76 runs/WEEK; busiest UTC day (Sunday slate plus the
--                    Sunday-night spillover) is 32 runs. Each run is
--                    1 getNFLGamesForWeek + one box score per game that is
--                    actually live: games that have not kicked off have no
--                    stats, and final games are frozen and fetched once.
--                    Worst case for a 16-game Sunday is 1 + 16 on a single
--                    run, and far less on every run after it.
-- Total steady-state is a small fraction of the 1,000/day allowance, so the
-- headroom is there if these cadences ever need tightening.
--
-- GAME-DAY WINDOWS — IMPORTANT: pg_cron schedules are UTC
-- ----------------------------------------------------------------------------
-- NFL games are played in US Eastern time, and every night game runs past
-- midnight UTC — so a night game lands on the NEXT UTC day. Getting this
-- wrong silently drops TDs, so the windows are deliberately generous
-- (they also absorb the EDT->EST shift that happens mid-season):
--   Thursday Night Football  (Thu ~8:15pm ET) -> UTC FRIDAY    00:00-04:59
--   Saturday games, wks 15+  (Sat afternoon)  -> UTC SATURDAY  17:00-23:59
--   Saturday night spillover                  -> UTC SUNDAY    00:00-04:59
--   Sunday slate + London games (9:30am ET)   -> UTC SUNDAY    13:00-23:59
--   Sunday Night Football spillover           -> UTC MONDAY    00:00-04:59
--   Monday Night Football     (Mon ~8:15pm ET)-> UTC TUESDAY   00:00-04:59
-- The 00:00-04:59 night window therefore fires on UTC days Sun, Mon, Tue and
-- Fri (dow 0,1,2,5). Monday Night Football is covered by the Tuesday leg —
-- do not drop it, MNF is a weekly regular-season fixture.
--
-- BEFORE YOU RUN THIS — edit exactly ONE line
-- ----------------------------------------------------------------------------
-- Set v_key in the DO block below to your service_role key (Studio -> Project
-- Settings -> API -> service_role "secret"). The project ref is already filled
-- in: it is public, it is literally in your Supabase URL.
--
-- This file used to carry <PROJECT_REF>/<SERVICE_ROLE_KEY> placeholders in
-- twelve separate places, which meant a missed one scheduled a job that
-- failed at runtime with "Bad hostname" rather than failing here. Now the
-- values are declared once and the job commands are built with format(), so
-- there is a single thing to edit and a guard that refuses to run without it.
--
-- Still a SECRET: do not commit a filled-in copy of this file.
-- ============================================================================

-- Required extensions (available on Supabase; safe if already enabled).
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ----------------------------------------------------------------------------
-- Idempotency: unschedule any previously-scheduled jobs with these names
-- before re-scheduling, so re-running this file after editing an interval
-- doesn't leave duplicate jobs behind.
-- ----------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname in (
    'tdsonly-sync-players',
    'tdsonly-sync-schedule',
    'tdsonly-sync-scores',          -- legacy single-job name, pre game-day windows
    'tdsonly-sync-scores-night',
    'tdsonly-sync-scores-saturday',
    'tdsonly-sync-scores-sunday',
    'tdsonly-apply-locks'
  );
exception
  when others then
    -- cron.job may not exist yet on a totally fresh project; ignore.
    null;
end $$;

-- ----------------------------------------------------------------------------
-- Schedule every job from one place, with the URL/key substituted once.
--
-- Cadences (see CALL BUDGET above):
--   sync-players   every 6h
--   sync-schedule  every 12h
--   sync-scores    every 30 min inside the UTC game-day windows, split into
--                  three jobs because the windows are not expressible as a
--                  single cron expression
--   apply-locks    every 5 min (DB-only, costs no API quota)
-- ----------------------------------------------------------------------------
do $$
declare
  v_ref text := '<PROJECT_REF>';
  v_key text := '<SERVICE_ROLE_KEY>';
  v_job record;
  v_cmd text;
begin
  if v_key like '<%>' or length(v_key) < 40 then
    raise exception
      'Set v_key to your real service_role key before running this file.';
  end if;
  if v_ref like '<%>' then
    raise exception 'Set v_ref to your Supabase project ref before running this file.';
  end if;

  for v_job in
    select *
    from (values
      ('tdsonly-sync-players',        '0 */6 * * *',            'sync-players'),
      ('tdsonly-sync-schedule',       '30 */12 * * *',          'sync-schedule'),
      -- Night games land on the NEXT UTC day: Fri=TNF, Sun=Sat night,
      -- Mon=SNF, Tue=MNF. Do not drop the Tuesday leg.
      ('tdsonly-sync-scores-night',   '*/30 0-4 * * 0,1,2,5',   'sync-scores'),
      ('tdsonly-sync-scores-saturday','*/30 17-23 * * 6',       'sync-scores'),
      -- 13:00 UTC start catches 9:30am ET London games.
      ('tdsonly-sync-scores-sunday',  '*/30 13-23 * * 0',       'sync-scores'),
      ('tdsonly-apply-locks',         '*/5 * * * *',            'apply-locks')
    ) as t(jobname, schedule, fn)
  loop
    v_cmd := format(
      $cmd$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body := '{}'::jsonb
      );
      $cmd$,
      format('https://%s.supabase.co/functions/v1/%s', v_ref, v_job.fn),
      'Bearer ' || v_key
    );

    perform cron.schedule(v_job.jobname, v_job.schedule, v_cmd);
    raise notice 'scheduled % (%)', v_job.jobname, v_job.schedule;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Verify: list scheduled jobs.
-- ----------------------------------------------------------------------------
-- select jobname, schedule, active,
--        command like '%<PROJECT_REF>%'      as still_has_ref_placeholder,
--        command like '%<SERVICE_ROLE_KEY>%' as still_has_key_placeholder
-- from cron.job where jobname like 'tdsonly-%' order by jobname;
--
-- NOTE: never `select command` from cron.job in the SQL editor — the job
-- command contains your service_role key and would be printed in the results.
--
-- To check recent run results:
-- select jobname, status, return_message, start_time
-- from cron.job_run_details jrd
-- join cron.job j on j.jobid = jrd.jobid
-- where j.jobname like 'tdsonly-%'
-- order by start_time desc
-- limit 20;

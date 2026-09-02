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
-- New cadences:
--   sync-players  @ every 6h  -> 4 runs/day x 33 = ~132 calls/day
--   sync-schedule @ every 12h -> 2 runs/day
--   sync-scores   -> 76 runs/WEEK total; busiest UTC day (Sunday slate plus
--                    the Sunday-night spillover) is 32 runs. Even at one
--                    call per in-progress game that is ~320 calls that day.
-- NOTE: if Tank01 turns out to expose a whole-league player list and/or a
-- whole-week boxscore in ONE call, these numbers drop by another order of
-- magnitude and sync-players could go back to a tighter interval.
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
-- BEFORE YOU RUN THIS — fill in two placeholders below
-- ----------------------------------------------------------------------------
-- 1. <PROJECT_REF> — your Supabase project ref (Studio -> Project Settings
--    -> General -> Reference ID), used to build the Edge Function URL:
--      https://<PROJECT_REF>.supabase.co/functions/v1/<function-name>
-- 2. <SERVICE_ROLE_KEY> — your project's service_role key (Studio ->
--    Project Settings -> API -> service_role secret). This is sent as a
--    Bearer token so the request passes Edge Functions' JWT check AND so
--    the function itself has the service-role env vars it needs — the key
--    used here is unrelated to (does not set) the function's own
--    SUPABASE_SERVICE_ROLE_KEY secret; that's set separately via
--    `supabase secrets set` (see supabase/functions/README.md).
--
-- These are SECRETS. Do not commit a filled-in copy of this file. The
-- recommended flow is: paste this file into the Supabase Studio SQL
-- editor, hand-edit the two placeholders there (not in git), and run it
-- once. Re-running is safe (see idempotency note below).
--
-- If pg_cron/pg_net are fiddly on your plan (they need to be enabled as
-- extensions, and some plans/tiers restrict pg_cron), the SIMPLER
-- ALTERNATIVE is the Supabase Dashboard's own Edge Functions scheduler:
--   Studio -> Edge Functions -> select a function -> "Cron" tab -> set an
--   interval (e.g. "*/20 * * * *"). No SQL required, no secrets pasted
--   into the SQL editor, and Supabase manages the auth token for you. This
--   file is here for teams who prefer everything as reviewable/rerunnable
--   SQL, or whose plan doesn't expose the dashboard scheduler.
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
-- sync-players — every 6 hours (1 + 32 calls per run; see CALL BUDGET above)
-- ----------------------------------------------------------------------------
select cron.schedule(
  'tdsonly-sync-players',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-players',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ----------------------------------------------------------------------------
-- sync-schedule — every 12 hours (kickoff times/byes change rarely)
-- ----------------------------------------------------------------------------
select cron.schedule(
  'tdsonly-sync-schedule',
  '30 */12 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-schedule',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ----------------------------------------------------------------------------
-- sync-scores — every 30 minutes, GAME-DAY WINDOWS ONLY (all times UTC).
-- Split into three jobs because the windows are not expressible as one cron
-- entry. See the GAME-DAY WINDOWS section at the top before editing these.
-- ----------------------------------------------------------------------------

-- Night games (all kick off in the evening ET, i.e. after 00:00 UTC the
-- FOLLOWING day). UTC dow 5=Fri covers Thursday Night Football, 0=Sun covers
-- Saturday night, 1=Mon covers Sunday Night Football, 2=Tue covers Monday
-- Night Football.
select cron.schedule(
  'tdsonly-sync-scores-night',
  '*/30 0-4 * * 0,1,2,5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-scores',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Saturday afternoon/evening games (Weeks 15-18 and the playoffs).
select cron.schedule(
  'tdsonly-sync-scores-saturday',
  '*/30 17-23 * * 6',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-scores',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- The Sunday slate. Starts at 13:00 UTC to catch London games (9:30am ET);
-- the Sunday-night spillover past midnight UTC is handled by the night job.
select cron.schedule(
  'tdsonly-sync-scores-sunday',
  '*/30 13-23 * * 0',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-scores',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ----------------------------------------------------------------------------
-- apply-locks — every 5 minutes
-- ----------------------------------------------------------------------------
select cron.schedule(
  'tdsonly-apply-locks',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/apply-locks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ----------------------------------------------------------------------------
-- Verify: list scheduled jobs.
-- ----------------------------------------------------------------------------
-- select jobname, schedule, active from cron.job where jobname like 'tdsonly-%';
--
-- To check recent run results:
-- select jobname, status, return_message, start_time
-- from cron.job_run_details jrd
-- join cron.job j on j.jobid = jrd.jobid
-- where j.jobname like 'tdsonly-%'
-- order by start_time desc
-- limit 20;

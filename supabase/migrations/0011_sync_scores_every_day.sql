-- ============================================================================
-- 0011_sync_scores_every_day.sql
-- TD's Only League — stop scheduling score syncs by day of week
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0010.
--
-- WHY
-- ----------------------------------------------------------------------------
-- 0004_cron.sql polled for scores only inside hand-written game-day windows,
-- enumerated by UTC day of week:
--     tdsonly-sync-scores-night     */30 0-4   * * 0,1,2,5
--     tdsonly-sync-scores-saturday  */30 17-23 * * 6
--     tdsonly-sync-scores-sunday    */30 13-23 * * 0
--
-- Those windows encode an assumption the NFL does not honour: that games are
-- played Thursday through Monday. Week 1 of this season opens on a WEDNESDAY
-- night (kickoff 2026-09-10T00:20Z — Wed 8:20pm ET, which is Thursday in UTC,
-- day-of-week 4, a day no window covers). The opener would have gone
-- completely unpolled, with the next run over 20 hours later.
--
-- Wednesday is not a one-off. Black Friday and Christmas Day games break the
-- same windows the same way. The enumeration itself is the defect, so this
-- migration removes it rather than adding a fourth special case that the next
-- odd fixture will also miss.
--
-- COST OF JUST RUNNING ALWAYS
-- ----------------------------------------------------------------------------
-- Every 30 minutes, all week, is 48 runs/day. sync-scores makes ONE call
-- (getNFLGamesForWeek) when nothing is live, and only fetches box scores for
-- games actually in progress — games not yet kicked off have no stats, and
-- final games are frozen and fetched once (see shouldFetch() in
-- sync-scores/index.ts). So the floor is ~48 calls/day, and the worst case, a
-- full Sunday slate, lands near 250. The Tank01 Pro allowance is 1,000/day.
-- The headroom was always there; the windows were buying budget we did not
-- need at the cost of correctness.
--
-- HOW (and why not just recreate the jobs)
-- ----------------------------------------------------------------------------
-- The cron commands carry a service-role key inline, which this file must not
-- contain. cron.alter_job() changes the schedule and leaves the command — key
-- and all — untouched, so nothing secret has to be re-pasted. The two
-- redundant jobs are then unscheduled; all three ran an identical command,
-- verified by fingerprint before writing this.
-- ============================================================================

do $$
declare
  v_id bigint;
begin
  select jobid into v_id from cron.job where jobname = 'tdsonly-sync-scores-night';

  if v_id is null then
    raise exception
      'No job named tdsonly-sync-scores-night — has 0004_cron.sql been run? Nothing changed.';
  end if;

  -- Every 30 minutes, every hour, every day. No day-of-week reasoning left to
  -- get wrong, and no UTC-vs-Eastern conversion to re-derive each season.
  perform cron.alter_job(v_id, schedule => '*/30 * * * *');

  -- The surviving job now covers the whole week, so the day-scoped ones are
  -- pure duplication — they would just double-fire during their old windows.
  if exists (select 1 from cron.job where jobname = 'tdsonly-sync-scores-saturday') then
    perform cron.unschedule('tdsonly-sync-scores-saturday');
  end if;
  if exists (select 1 from cron.job where jobname = 'tdsonly-sync-scores-sunday') then
    perform cron.unschedule('tdsonly-sync-scores-sunday');
  end if;
end $$;

-- Cosmetic: "-night" is now a lie about what the job does. Renaming needs
-- write access to cron.job, which the SQL editor's role may not have — it is
-- not worth failing the migration over, so skip it if it is refused.
do $$
begin
  update cron.job
     set jobname = 'tdsonly-sync-scores'
   where jobname = 'tdsonly-sync-scores-night';
exception
  when insufficient_privilege then null;
  when others then null;
end $$;

-- ============================================================================
-- 0006_tank01_stage_addressing.sql
-- TD's Only League — re-address stages for the Tank01 API
--
-- WHY
-- ----------------------------------------------------------------------------
-- stages addressed weeks the way ESPN's scoreboard endpoint did:
--   espn_season_type smallint  -- 2 = regular season, 3 = postseason
--   espn_week_num    smallint  -- week within that season type
-- Tank01's getNFLGamesForWeek takes a different shape: a STRING seasonType, a
-- week number, and — unlike ESPN — an explicit season YEAR. So these columns
-- are renamed to provider-neutral names and retyped.
--
-- THE POSTSEASON ROWS ARE DELIBERATELY LEFT NULL. READ THIS BEFORE "FIXING".
-- ----------------------------------------------------------------------------
-- We captured real Tank01 responses for a regular-season week (see
-- reference/tank01/getNFLGamesForWeek.sample.json) and they carry
-- seasonType "Regular Season". We have NOT captured a playoff week, so we do
-- not know either:
--   (a) the exact seasonType value the REQUEST expects for playoff rounds, or
--   (b) how playoff weeks are numbered.
-- ESPN numbered them 1/2/3/5 with no week 4, which is exactly the kind of
-- provider quirk that does not transfer.
--
-- The whole reason this league moved off ESPN was shipping code written
-- against unverified field names, so rather than guess and have four January
-- stages silently sync the wrong games, the four postseason rows get NULL
-- addressing. sync-schedule and sync-scores treat a NULL-addressed stage as
-- "not yet configured": they skip it and say so in sync_log, instead of
-- fetching garbage.
--
-- TO FINISH THE POSTSEASON (one call to confirm, then one UPDATE):
--   curl --request GET \
--     --url 'https://tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com/getNFLGamesForWeek?week=1&seasonType=post&season=2025' \
--     --header 'X-RapidAPI-Key: <key>' \
--     --header 'X-RapidAPI-Host: tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com'
-- Check what seasonType comes back in the response and how many games. Then:
--   update public.stages set season_type = '<confirmed>', week_num = 1 where ordinal = 19; -- Wild Card
--   update public.stages set season_type = '<confirmed>', week_num = 2 where ordinal = 20; -- Divisional
--   update public.stages set season_type = '<confirmed>', week_num = 3 where ordinal = 21; -- Conference
--   update public.stages set season_type = '<confirmed>', week_num = 4 where ordinal = 22; -- Super Bowl
-- (…assuming playoff weeks are 1-4. Confirm that from the response too.)
--
-- Safe to re-run top to bottom in the Supabase SQL editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add the provider-neutral columns. Nullable on purpose: a stage with no
--    addressing is a real, meaningful state (see the postseason note above).
-- ----------------------------------------------------------------------------
alter table public.stages add column if not exists season_type text;
alter table public.stages add column if not exists week_num smallint;

comment on column public.stages.season_type is
  'Value passed as Tank01 getNFLGamesForWeek?seasonType=. NULL means this '
  'stage is not yet addressable and sync jobs will skip it.';
comment on column public.stages.week_num is
  'Value passed as Tank01 getNFLGamesForWeek?week=. NULL means this stage is '
  'not yet addressable and sync jobs will skip it.';

-- ----------------------------------------------------------------------------
-- 2. Backfill from the old ESPN columns, if they are still present.
--    Regular season (espn_season_type = 2) maps cleanly: week numbers are the
--    same 1..18. Postseason is intentionally NOT backfilled.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stages'
      and column_name = 'espn_season_type'
  ) then
    update public.stages
       set season_type = 'Regular Season',
           week_num    = espn_week_num
     where espn_season_type = 2
       and season_type is null;
  end if;
end $$;

-- Fallback for a database where the old columns were already dropped: address
-- the 18 regular-season stages by their ordinal, which is stable (1..18).
update public.stages
   set season_type = 'Regular Season',
       week_num    = ordinal
 where ordinal between 1 and 18
   and (season_type is null or week_num is null);

-- Postseason stays NULL until confirmed against a real playoff response.
update public.stages
   set season_type = null,
       week_num    = null
 where ordinal between 19 and 22;

-- ----------------------------------------------------------------------------
-- 3. Drop the ESPN-shaped columns. Nothing reads them after this migration:
--    supabase/functions/_shared/stage.ts and both sync jobs now use
--    season_type / week_num.
-- ----------------------------------------------------------------------------
alter table public.stages drop column if exists espn_season_type;
alter table public.stages drop column if exists espn_week_num;

-- ----------------------------------------------------------------------------
-- 4. Guard rails. A regular-season stage must be fully addressed or fully
--    unaddressed — a half-set row would send week=NULL to the API and get a
--    confusing empty result rather than an obvious failure.
-- ----------------------------------------------------------------------------
alter table public.stages drop constraint if exists stages_addressing_complete;
alter table public.stages add constraint stages_addressing_complete
  check ((season_type is null) = (week_num is null));

alter table public.stages drop constraint if exists stages_week_num_sane;
alter table public.stages add constraint stages_week_num_sane
  check (week_num is null or (week_num between 1 and 22));

-- ----------------------------------------------------------------------------
-- Verify:
--   select ordinal, name, season_type, week_num from public.stages order by ordinal;
-- Expect: ordinals 1-18 addressed as ('Regular Season', 1..18),
--         ordinals 19-22 with NULL season_type and NULL week_num.
-- ----------------------------------------------------------------------------

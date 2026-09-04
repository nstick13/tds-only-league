-- ============================================================================
-- 0010_realtime_publication.sql
-- TD's Only League — turn on live draft updates
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0009.
--
-- WHY NOTHING WAS UPDATING LIVE
-- ----------------------------------------------------------------------------
-- The app has been fully wired for live updates since the draft room was
-- built: subscribeToDraft() in src/lib/realtime.ts opens a `draft:{stageId}`
-- channel, and DraftBoard refetches picks and draft order on every event.
-- What was missing is entirely on the database side — Supabase only streams
-- Postgres Changes for tables in the `supabase_realtime` publication, and
-- that publication was EMPTY. Every client subscribed correctly and then sat
-- there hearing nothing, because nothing was ever published.
--
-- Adding the two draft tables is the whole fix. No application change.
--
-- REPLICA IDENTITY FULL — needed for DELETEs, not just a nicety
-- ----------------------------------------------------------------------------
-- Subscriptions are filtered by `stage_id=eq.{id}` so two stages' draft rooms
-- don't cross-talk. Postgres only includes the PRIMARY KEY in a DELETE's old
-- record by default, so a delete event would carry no stage_id and the filter
-- would drop it — meaning an undone pick (or a commissioner replacement,
-- which deletes the old row) would never reach anyone else's screen, while
-- ordinary picks did. That asymmetry would be a maddening bug to chase.
-- `replica identity full` puts the whole old row in the WAL so deletes match
-- the filter like every other event. These tables are small (48 draft slots,
-- 48 picks per stage), so the extra WAL volume is irrelevant here.
--
-- RLS still applies to realtime: each subscriber only receives rows their
-- own SELECT policies would let them read. Both tables already allow any
-- authenticated league member to read (0003_rls.sql), which is what we want
-- — the draft board is public within the league.
-- ============================================================================

alter table public.roster_picks replica identity full;
alter table public.draft_order replica identity full;

-- Idempotent: adding a table already in the publication raises, so check.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'roster_picks'
  ) then
    alter publication supabase_realtime add table public.roster_picks;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'draft_order'
  ) then
    alter publication supabase_realtime add table public.draft_order;
  end if;
end $$;

-- ============================================================================
-- 0014_lock_rosters_by_clock.sql
-- TD's Only League — rosters lock at kickoff by the clock, not by a cron job
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0013.
--
-- WHY
-- ----------------------------------------------------------------------------
-- "Rosters lock at first kickoff" was enforced in exactly one place: the
-- apply-locks Edge Function flipping stages.status to 'locked', with the RLS
-- policies below trusting that flag. That makes the league's central fairness
-- rule depend on a cron job winning a race against kickoff.
--
-- It does not reliably win. On 2026-09-13, apply-locks failed 33 of 54 runs
-- with "stages select failed: Gateway Timeout", and the failures came in
-- CLUSTERS, not isolated blips — 17:40/17:45/17:50 all failed, then
-- 18:05/18:10/18:15/18:20 all failed. A ~20 minute outage window that happens
-- to straddle kickoff leaves the stage sitting at 'draft_open' well after
-- games have started, and every policy below would happily accept a pick for
-- a player who has already scored.
--
-- The database knows what time it is and it knows first_kickoff_at. It does
-- not need to be told by an Edge Function. Checking the clock here closes the
-- window completely: there is no interval, however brief, in which a manager
-- can write a pick after kickoff.
--
-- apply-locks still runs and still matters — stages.status is what the UI
-- reads to show a draft as closed, and 'locked' is a precondition for
-- finalizing a week. It is now bookkeeping rather than enforcement, so its
-- timeouts cost a stale-looking screen instead of a corrupted week.
--
-- first_kickoff_at IS NULL keeps the old behaviour deliberately: a stage
-- whose schedule has not been synced yet has no kickoff to be past, and
-- apply-locks skips those too (it filters on `not first_kickoff_at is null`).
--
-- COMMISSIONERS ARE UNAFFECTED. roster_picks_all_commissioner still grants
-- full access in any stage status, which is the sanctioned path for post-lock
-- corrections (and for replace_roster_pick, 0009). This migration constrains
-- managers editing their own rosters, nothing else.
-- ============================================================================

-- A manager may insert their own picks only while the stage's draft is open
-- AND kickoff has not yet passed.
drop policy if exists "roster_picks_insert_own_while_open" on public.roster_picks;
create policy "roster_picks_insert_own_while_open"
  on public.roster_picks for insert
  to authenticated
  with check (
    manager_id = auth.uid()
    and exists (
      select 1 from public.stages
      where stages.id = roster_picks.stage_id
        and stages.status = 'draft_open'
        and (stages.first_kickoff_at is null
             or now() < stages.first_kickoff_at)
    )
  );

-- Same for undoing a mis-click: allowed right up to kickoff, never after it.
drop policy if exists "roster_picks_delete_own_while_open" on public.roster_picks;
create policy "roster_picks_delete_own_while_open"
  on public.roster_picks for delete
  to authenticated
  using (
    manager_id = auth.uid()
    and exists (
      select 1 from public.stages
      where stages.id = roster_picks.stage_id
        and stages.status = 'draft_open'
        and (stages.first_kickoff_at is null
             or now() < stages.first_kickoff_at)
    )
  );

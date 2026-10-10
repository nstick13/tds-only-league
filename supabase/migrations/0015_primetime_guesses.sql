-- ============================================================================
-- 0015_primetime_guesses.sql
-- TD's Only League — next week's draft order comes from a SNF + MNF guess
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0014. Purely additive (one new table, three new stages columns), so it is
-- safe to run before the app code that uses it is deployed — the current app
-- simply ignores both.
--
-- THE RULE
-- ----------------------------------------------------------------------------
-- While drafting a week, every manager guesses the COMBINED final score of
-- that week's Sunday Night and Monday Night games (both teams, both games),
-- and must have a guess in before making their final pick. The sync-scores
-- Edge Function records each game's final score from the Tank01 box score it
-- already fetches (homePts + awayPts) — nobody types it in. At finalize the
-- next week's round-1 order is closest guess first (over and under count the
-- same). The snake is unchanged.
--
-- Ties on distance go to most TE points that week, then WR, RB, QB, then a
-- coin flip. Total points / total TDs are deliberately NOT tiebreakers here —
-- a manager who scored less overall can still win the tie on TE points.
-- That logic lives in src/lib/draftOrder.ts (seedRoundOneFromGuesses).
--
-- VISIBILITY
-- ----------------------------------------------------------------------------
-- Guesses are sealed until kickoff: a manager sees only their own until the
-- stage locks (or first kickoff passes), so nobody can see a 47 and answer
-- with a 48. Commissioners see and can edit everything.
-- ============================================================================

create table if not exists public.draft_guesses (
  stage_id smallint not null references public.stages (id) on delete cascade,
  manager_id uuid not null references public.profiles (id) on delete cascade,
  guess smallint not null check (guess between 0 and 300),
  updated_at timestamptz not null default now(),
  primary key (stage_id, manager_id)
);

comment on table public.draft_guesses is
  'Each manager''s guess at a stage''s combined SNF + MNF final score. Closest guess picks first in the next stage''s draft. Sealed from other managers until kickoff.';

-- Each primetime game's combined final score (both teams), written by
-- sync-scores once the game is over. primetime_total is their sum, and stays
-- null until BOTH are in — finalize refuses to seed a draft off half a total.
alter table public.stages add column if not exists snf_total smallint
  check (snf_total is null or snf_total >= 0);
alter table public.stages add column if not exists mnf_total smallint
  check (mnf_total is null or mnf_total >= 0);
alter table public.stages add column if not exists primetime_total smallint
  generated always as (snf_total + mnf_total) stored;

alter table public.draft_guesses enable row level security;

-- Your own guess is always visible to you; everyone's becomes visible once
-- the stage is past its draft (locked/finalized) or kickoff has passed.
drop policy if exists "draft_guesses_select" on public.draft_guesses;
create policy "draft_guesses_select"
  on public.draft_guesses for select
  to authenticated
  using (
    manager_id = auth.uid()
    or public.is_commissioner(auth.uid())
    or exists (
      select 1 from public.stages
      where stages.id = draft_guesses.stage_id
        and (stages.status in ('locked', 'finalized')
             or (stages.first_kickoff_at is not null
                 and now() >= stages.first_kickoff_at))
    )
  );

-- A manager may set or change their own guess only while the draft is open
-- and before kickoff — the same window as their picks (see 0014).
drop policy if exists "draft_guesses_insert_own_while_open" on public.draft_guesses;
create policy "draft_guesses_insert_own_while_open"
  on public.draft_guesses for insert
  to authenticated
  with check (
    manager_id = auth.uid()
    and exists (
      select 1 from public.stages
      where stages.id = draft_guesses.stage_id
        and stages.status = 'draft_open'
        and (stages.first_kickoff_at is null
             or now() < stages.first_kickoff_at)
    )
  );

drop policy if exists "draft_guesses_update_own_while_open" on public.draft_guesses;
create policy "draft_guesses_update_own_while_open"
  on public.draft_guesses for update
  to authenticated
  using (manager_id = auth.uid())
  with check (
    manager_id = auth.uid()
    and exists (
      select 1 from public.stages
      where stages.id = draft_guesses.stage_id
        and stages.status = 'draft_open'
        and (stages.first_kickoff_at is null
             or now() < stages.first_kickoff_at)
    )
  );

drop policy if exists "draft_guesses_all_commissioner" on public.draft_guesses;
create policy "draft_guesses_all_commissioner"
  on public.draft_guesses for all
  to authenticated
  using (public.is_commissioner(auth.uid()))
  with check (public.is_commissioner(auth.uid()));

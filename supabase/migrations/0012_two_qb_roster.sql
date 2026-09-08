-- ============================================================================
-- 0012_two_qb_roster.sql
-- TD's Only League — rosters carry TWO quarterbacks
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0011.
--
-- WHAT CHANGES
-- ----------------------------------------------------------------------------
-- Roster shape goes from QB1/RB2/WR2/TE1 (6 players) to QB2/RB2/WR2/TE1
-- (7 players). The roster GROWS — no other position gives up a slot.
--
-- Because every manager fills their whole roster in the draft, one more
-- roster slot means one more draft round: 8 managers x 7 rounds = 56 picks,
-- up from 48. Three things follow from that, all handled below:
--
--   1. enforce_roster_limits() caps QB at 2 and the total at 7.
--   2. draft_order.pick_number's CHECK allowed 1..48; it now allows 1..56.
--      This has to change BEFORE any round-7 row is inserted.
--   3. Week 1's draft was already COMPLETE under the old shape (48 picks,
--      all 8 managers). It gets a 7th round appended so everyone can draft
--      their second QB, rather than being left one short of a legal roster.
--
-- The application side matches this already: src/lib/roster.ts holds the
-- shape, and generateDraftOrder derives its round count from ROSTER_SIZE, so
-- every stage drafted from here on gets 7 rounds with no further change.
--
-- WHY ROUND 7 IS THE REVERSE OF ROUND 6
-- ----------------------------------------------------------------------------
-- The draft snakes: round 1 in base order, round 2 reversed, alternating. So
-- round 7 runs in the reverse of round 6's order, which means whoever picked
-- 48th also picks 49th — back-to-back, exactly as the snake implies. Round 7
-- is derived from the round-6 rows actually stored rather than recomputed
-- from a base order, so a hand-edited order carries through correctly.
--
-- Safe to re-run: the round-7 insert is skipped if those picks already exist.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Widen the pick_number range FIRST — the round-7 insert below depends on
--    it, and so does every future 7-round stage.
-- ----------------------------------------------------------------------------
alter table public.draft_order drop constraint if exists draft_order_pick_number_check;
alter table public.draft_order add constraint draft_order_pick_number_check
  check (pick_number between 1 and 56);

comment on table public.draft_order is
  'Overall snake draft order per stage (56 picks = 8 managers x 7 rounds).';

-- ----------------------------------------------------------------------------
-- 2. Roster caps: QB 2, total 7.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_roster_limits()
returns trigger
language plpgsql
as $$
declare
  position_cap smallint;
  position_count int;
  total_count int;
  roster_total constant int := 7;
begin
  position_cap := case new.slot_position
    when 'QB' then 2
    when 'RB' then 2
    when 'WR' then 2
    when 'TE' then 1
    else null
  end;

  if position_cap is null then
    raise exception 'Unknown slot_position %', new.slot_position;
  end if;

  select count(*) into position_count
  from public.roster_picks
  where stage_id = new.stage_id
    and manager_id = new.manager_id
    and slot_position = new.slot_position;

  if position_count >= position_cap then
    raise exception
      'Roster limit exceeded: manager % already has % % pick(s) for stage % (cap %)',
      new.manager_id, position_count, new.slot_position, new.stage_id, position_cap;
  end if;

  select count(*) into total_count
  from public.roster_picks
  where stage_id = new.stage_id
    and manager_id = new.manager_id;

  if total_count >= roster_total then
    raise exception
      'Roster limit exceeded: manager % already holds % players for stage %',
      new.manager_id, roster_total, new.stage_id;
  end if;

  return new;
end;
$$;

comment on function public.enforce_roster_limits is
  'BEFORE INSERT trigger on roster_picks enforcing QB2/RB2/WR2/TE1 per-position caps and a 7-player total, per manager per stage. Mirrors src/lib/roster.ts.';

-- ----------------------------------------------------------------------------
-- 3. Append round 7 to any stage whose draft order stopped at 48.
--    Reverses that stage's round 6 (picks 41-48), so pick 49 goes to whoever
--    holds pick 48.
-- ----------------------------------------------------------------------------
insert into public.draft_order (stage_id, pick_number, manager_id)
select d.stage_id,
       48 + row_number() over (partition by d.stage_id order by d.pick_number desc),
       d.manager_id
  from public.draft_order d
 where d.pick_number between 41 and 48
   and d.stage_id in (
     select stage_id
       from public.draft_order
      group by stage_id
     having max(pick_number) = 48
        and count(*) = 48
   )
on conflict (stage_id, pick_number) do nothing;

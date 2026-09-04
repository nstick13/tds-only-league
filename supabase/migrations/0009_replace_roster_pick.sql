-- ============================================================================
-- 0009_replace_roster_pick.sql
-- TD's Only League — atomic commissioner swap of an already-drafted player
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0008.
--
-- WHY A FUNCTION AND NOT TWO STATEMENTS
-- ----------------------------------------------------------------------------
-- The commish page previously swapped a player by DELETEing the old
-- roster_picks row and INSERTing the new one as two separate requests. Two
-- things go wrong with that:
--
--   1. It is not atomic. The delete lands, then the insert is rejected — the
--      player was taken by someone else a second ago, or the roster-limit
--      trigger fires — and the manager is left a player short with no
--      indication that half an edit was applied.
--   2. It loses pick_number. The insert wrote NULL, so a player swapped in
--      after the draft had no position in the pick order, degrading the
--      draft board and any history built from it.
--
-- Doing it in one function makes it one transaction: either the swap happens
-- completely or nothing changes. The replacement inherits the original row's
-- manager, slot AND pick_number, so the draft record stays intact.
--
-- POSITION IS DELIBERATELY NOT SWAPPABLE
-- ----------------------------------------------------------------------------
-- Rosters are a fixed shape (QB1 / RB2 / WR2 / TE1, enforced by
-- enforce_roster_limits() in 0002_functions.sql). A slot therefore keeps its
-- position: a QB slot takes a QB. Swapping a WR for a TE is not a
-- replacement, it is a different roster — the function rejects it with a
-- clear message rather than tripping the limit trigger with an opaque one.
-- To genuinely restructure a roster, remove and add separately.
-- ============================================================================

create or replace function public.replace_roster_pick(
  p_stage_id smallint,
  p_out_player_id text,
  p_in_player_id text
)
returns table (
  manager_id uuid,
  slot_position text,
  pick_number smallint,
  out_player_name text,
  in_player_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_pick public.roster_picks%rowtype;
  v_in public.players%rowtype;
  v_out_name text;
begin
  if not public.is_commissioner(v_uid) then
    raise exception 'Commissioner access required to replace a pick.'
      using errcode = '42501';
  end if;

  if p_out_player_id = p_in_player_id then
    raise exception 'The replacement is the same player already in that slot.'
      using errcode = '22023';
  end if;

  -- FOR UPDATE: hold the row for the length of this transaction so two
  -- commissioners replacing the same pick at once can't both succeed.
  select * into v_pick
    from public.roster_picks
   where stage_id = p_stage_id
     and player_id = p_out_player_id
   for update;

  if v_pick.id is null then
    raise exception 'That player is not on a roster in this stage — nothing to replace.'
      using errcode = 'P0002';
  end if;

  select * into v_in from public.players where id = p_in_player_id;
  if v_in.id is null then
    raise exception 'Replacement player not found.' using errcode = 'P0002';
  end if;

  if v_in.position is distinct from v_pick.slot_position then
    raise exception
      'Slot mismatch: that slot is %, but % is a %. Rosters are a fixed shape, so a slot keeps its position.',
      v_pick.slot_position, v_in.name, v_in.position
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.roster_picks
     where stage_id = p_stage_id and player_id = p_in_player_id
  ) then
    raise exception '% is already on a roster in this stage.', v_in.name
      using errcode = '23505';
  end if;

  select name into v_out_name from public.players where id = p_out_player_id;

  -- One transaction: if the insert fails, the delete is rolled back with it.
  delete from public.roster_picks where id = v_pick.id;

  insert into public.roster_picks
    (stage_id, manager_id, player_id, slot_position, pick_number)
  values
    (v_pick.stage_id, v_pick.manager_id, p_in_player_id, v_pick.slot_position,
     v_pick.pick_number);

  return query
    select v_pick.manager_id,
           v_pick.slot_position,
           v_pick.pick_number,
           coalesce(v_out_name, p_out_player_id),
           v_in.name;
end;
$$;

comment on function public.replace_roster_pick is
  'Atomically swaps one drafted player for another, preserving the original '
  'manager, slot_position and pick_number. Commissioner only.';

grant execute on function public.replace_roster_pick(smallint, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Verify (on a stage with picks):
--   select * from public.replace_roster_pick(1::smallint, '<drafted_id>', '<free_id>');
--   -- expect one row echoing manager/slot/pick_number and both player names
--   select player_id, slot_position, pick_number from public.roster_picks
--    where stage_id = 1 order by pick_number;
--   -- expect the new player sitting on the OLD player's pick_number
-- ----------------------------------------------------------------------------

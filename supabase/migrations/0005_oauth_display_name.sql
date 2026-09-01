-- ============================================================================
-- 0005_oauth_display_name.sql
-- TD's Only League — pick up display names from Google OAuth signups
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001–0003 have been run. Safe to re-run.
--
-- Why: auth moved from email/password to Google OAuth. Email signups put
-- the chosen name in raw_user_meta_data->>'display_name'; Google instead
-- provides 'full_name' (and 'name'). The original handle_new_user() only
-- looked at 'display_name', so Google managers would have shown up named by
-- their email address. This widens the fallback chain. Everything else
-- about the trigger (auto-assigning manager_slot 1..8 to the first 8
-- signups) is unchanged.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_slot smallint;
  taken_slots smallint;
  chosen_name text;
begin
  chosen_name := coalesce(
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    new.email
  );

  insert into public.profiles (id, display_name, email, is_commissioner, is_player)
  values (new.id, chosen_name, new.email, false, false)
  on conflict (id) do nothing;

  -- Auto-assign the lowest free manager_slot (1..8) if fewer than 8
  -- profiles currently hold one. New accounts default to
  -- is_commissioner = false, so this always applies to fresh signups.
  select count(*) into taken_slots
  from public.profiles
  where manager_slot is not null;

  if taken_slots < 8 then
    select min(s.slot) into next_slot
    from generate_series(1, 8) as s(slot)
    where s.slot not in (
      select manager_slot from public.profiles where manager_slot is not null
    );

    if next_slot is not null then
      update public.profiles
      set manager_slot = next_slot,
          is_player = true
      where id = new.id;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_user is
  'On auth.users insert: creates the profiles row (display name from display_name/full_name/name/email) and auto-assigns manager_slot 1..8 (is_player=true) to the first 8 signups.';

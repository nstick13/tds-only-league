-- ============================================================================
-- 0013_push_subscriptions.sql
-- TD's Only League — Web Push subscriptions
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor.
--
-- One row per browser a manager has enabled notifications in. A manager can
-- have several (phone home screen, laptop), so this is many-per-manager and
-- keyed by endpoint, which is the push service's unique URL for that install.
--
-- Notifications are sent from the Next.js app using the service_role key,
-- which bypasses RLS — the policies here exist so a signed-in manager can
-- manage their OWN subscriptions from the browser and read nothing else.
-- Endpoints are effectively bearer URLs: anyone holding one can push to that
-- device, so unlike every other table in this schema they are NOT readable
-- league-wide.
-- ============================================================================

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.profiles (id) on delete cascade,
  -- The push service URL. Unique because re-subscribing the same browser must
  -- update the existing row rather than accumulate duplicates that would each
  -- deliver the same notification.
  endpoint text not null unique,
  -- Keys from the browser's PushSubscription, needed to encrypt the payload.
  p256dh text not null,
  auth text not null,
  -- Helps a manager recognise which device a row is when revoking.
  user_agent text,
  created_at timestamptz not null default now(),
  -- Set when a push is rejected as gone (404/410); the sender deletes those
  -- rows, so a lingering value means a send failed for some other reason.
  last_failure_at timestamptz
);

create index if not exists push_subscriptions_manager_id_idx
  on public.push_subscriptions (manager_id);

comment on table public.push_subscriptions is
  'Web Push endpoints per manager per browser. Written by the manager themselves; read by the app''s service_role sender. Endpoints are secrets — never expose league-wide.';

alter table public.push_subscriptions enable row level security;

-- A manager sees, adds and removes only their own rows. No commissioner
-- override and no league-wide select: holding another manager's endpoint
-- would let you push notifications to their phone.
drop policy if exists "push_subscriptions_select_own" on public.push_subscriptions;
create policy "push_subscriptions_select_own"
  on public.push_subscriptions for select
  to authenticated
  using (manager_id = auth.uid());

drop policy if exists "push_subscriptions_insert_own" on public.push_subscriptions;
create policy "push_subscriptions_insert_own"
  on public.push_subscriptions for insert
  to authenticated
  with check (manager_id = auth.uid());

drop policy if exists "push_subscriptions_update_own" on public.push_subscriptions;
create policy "push_subscriptions_update_own"
  on public.push_subscriptions for update
  to authenticated
  using (manager_id = auth.uid())
  with check (manager_id = auth.uid());

drop policy if exists "push_subscriptions_delete_own" on public.push_subscriptions;
create policy "push_subscriptions_delete_own"
  on public.push_subscriptions for delete
  to authenticated
  using (manager_id = auth.uid());

-- ============================================================================
-- 0016_draft_reminders.sql
-- TD's Only League — hourly "still your pick" reminders
--
-- Run this ENTIRE file in one paste into the Supabase Studio SQL editor,
-- AFTER 0001..0015, and BEFORE deploying the app change that ships with it
-- (saving a push subscription writes the new time_zone column).
--
-- WHY
-- ----------------------------------------------------------------------------
-- The on-the-clock push fired once, from the pick that put you on the clock.
-- Miss it and nothing else nudged you while the whole draft waited. The app
-- now repeats it hourly until you pick, except from 10 PM to 8 AM in each
-- device's own time zone (src/lib/push/reminders.ts).
--
-- WHAT
-- ----------------------------------------------------------------------------
--   1. push_subscriptions.time_zone — the IANA zone the browser reports, so
--      quiet hours follow the phone rather than the server.
--   2. draft_clock_reminders — when each pick's clock started and when its
--      manager was last reminded. Service-role only: RLS on, no policies.
--   3. A pg_cron job POSTing to the app's /api/cron/draft-reminders every
--      15 minutes. The app (not an Edge Function) sends these because the
--      VAPID private key lives only in the app's environment.
--
-- BEFORE YOU RUN THIS — edit exactly ONE line
-- ----------------------------------------------------------------------------
-- Set v_secret in the DO block at the bottom to the same value as the app's
-- CRON_SECRET environment variable (Vercel → Settings → Environment
-- Variables; generate one with `openssl rand -hex 32`, then redeploy).
--
-- Still a SECRET: do not commit a filled-in copy of this file.
-- ============================================================================

alter table public.push_subscriptions
  add column if not exists time_zone text;

comment on column public.push_subscriptions.time_zone is
  'IANA time zone the browser reported (e.g. America/Chicago). Reminders are quiet 10 PM–8 AM in this zone; null falls back to America/New_York.';

create table if not exists public.draft_clock_reminders (
  stage_id smallint not null references public.stages (id) on delete cascade,
  pick_number smallint not null,
  manager_id uuid not null references public.profiles (id) on delete cascade,
  clock_started_at timestamptz not null,
  last_reminded_at timestamptz not null,
  primary key (stage_id, pick_number)
);

comment on table public.draft_clock_reminders is
  'One row per pick that has been on the clock: when it started and when its manager was last pushed a reminder. Written only by the app''s service-role reminder job.';

alter table public.draft_clock_reminders enable row level security;

do $$
declare
  v_url text := 'https://tds-only-league.vercel.app/api/cron/draft-reminders';
  v_secret text := '<CRON_SECRET>';
begin
  if v_secret like '<%>' or length(v_secret) < 32 then
    raise exception
      'Set v_secret to the app''s CRON_SECRET (32+ characters) before running this file.';
  end if;

  if exists (select 1 from cron.job where jobname = 'tdsonly-draft-reminders') then
    perform cron.unschedule('tdsonly-draft-reminders');
  end if;

  perform cron.schedule(
    'tdsonly-draft-reminders',
    '*/15 * * * *',
    format(
      $cmd$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', %L
        ),
        body := '{}'::jsonb
      );
      $cmd$,
      v_url,
      'Bearer ' || v_secret
    )
  );
  raise notice 'scheduled tdsonly-draft-reminders (*/15 * * * *)';
end $$;

-- To check recent runs (never `select command` — it contains the secret):
-- select status, return_message, start_time
-- from cron.job_run_details jrd
-- join cron.job j on j.jobid = jrd.jobid
-- where j.jobname = 'tdsonly-draft-reminders'
-- order by start_time desc
-- limit 10;
--
-- pg_net records the app's answer, including which pick was reminded:
-- select status_code, content from net._http_response order by created desc limit 5;

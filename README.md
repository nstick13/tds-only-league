# TD's Only League

A private, 8-manager fantasy football league app. TD-only scoring
(passing TD = 0.5 pt, rushing TD = 1.0 pt, receiving TD = 1.0 pt),
**weekly redraft**: every stage (Week 1–18, then the four playoff rounds)
every manager's roster is fully wiped and re-drafted from scratch, live,
with all 8 managers watching picks happen in real time. Rosters are 1 QB,
2 RB, 2 WR, 1 TE, and a player can only be on **one** manager's roster per
stage league-wide. Player and stat data comes from ESPN's public
(unofficial) API.

## Stack

- [Next.js](https://nextjs.org/) (App Router, TypeScript, `src/` layout)
- [Tailwind CSS](https://tailwindcss.com/) — retro Tecmo Super Bowl / 8-bit
  Nintendo look (see `docs/ARCHITECTURE.md`)
- [Supabase](https://supabase.com/) — Postgres, Auth, Realtime, Edge
  Functions
- Deploy target: [Vercel](https://vercel.com/) (frontend) + Supabase
  (backend)

## Local dev

```bash
npm install
cp .env.example .env.local   # then fill in real values, see below
npm run dev
```

Other scripts: `npm run build`, `npm run lint`, `npm run typecheck`.

### Environment variables

Set these in `.env.local` for local dev, and in your Vercel project's
Environment Variables for deploys. Real values come from your Supabase
project's **Settings → API** page.

| Variable | Where it's used | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Project URL. Safe to expose. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | anon/public key. Safe to expose — RLS protects data. |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only / Edge Functions | **Secret.** Bypasses RLS. Never expose to the browser. |

See `.env.example` for a copy-pasteable template with comments.

## Setting up Supabase (no coding required)

These steps are for whoever is standing up the Supabase project for the
league (this can be done entirely from an iPad browser, no terminal
needed).

1. Go to [supabase.com](https://supabase.com/), sign in, and create a new
   project. Pick any name/region; set a database password and save it
   somewhere safe (you likely won't need it day-to-day).
2. Once the project finishes provisioning, open the **SQL Editor** in the
   left sidebar (the `>_` icon).
3. Open `supabase/migrations/0001_core.sql` in this repo (on GitHub, or
   wherever you're reading these files). Select all its contents, copy,
   paste into a **New query** in the SQL Editor, and click **Run**. You
   should see "Success. No rows returned."
4. Repeat step 3 for `supabase/migrations/0002_functions.sql` — a new
   query, paste the whole file, Run.
5. Repeat step 3 again for `supabase/migrations/0003_rls.sql`, then once
   more for `supabase/migrations/0005_oauth_display_name.sql` — a new
   query each, paste the whole file, Run.
   - **Run them in this exact order** (0001, 0002, 0003, then 0005) — each
     one depends on the previous ones having already run. (0004 is the
     optional cron/scheduling file; run it too if you're wiring up the
     automated ESPN sync jobs.)
6. Go to **Settings → API** in the left sidebar. Copy the **Project URL**,
   the **anon public** key, and the **service_role** key — you'll paste
   these into `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   and `SUPABASE_SERVICE_ROLE_KEY` respectively (in `.env.local` for local
   dev, or in your Vercel project's Environment Variables for the deployed
   site). **Never share the service_role key** — treat it like a master
   password.
7. **Set up Sign in with Google.** Auth is Google OAuth — no passwords, no
   email-confirmation step.
   a. In Supabase, go to **Authentication → Providers → Google** and toggle
      it on. It shows you a **Callback URL** that looks like
      `https://<your-project-ref>.supabase.co/auth/v1/callback` — copy it.
   b. In the [Google Cloud Console](https://console.cloud.google.com/),
      create (or reuse) a project, then **APIs & Services → Credentials →
      Create Credentials → OAuth client ID → Web application**. Under
      **Authorized redirect URIs**, paste the Supabase Callback URL from
      step (a). Save, then copy the generated **Client ID** and **Client
      secret**.
   c. Paste that Client ID and secret back into the Supabase Google
      provider form and save.
8. **Point Supabase at your app's real URLs** (this is what fixes redirects
   landing on `localhost`). Go to **Authentication → URL Configuration**:
   - Set **Site URL** to your deployed app, e.g.
     `https://tds-only-league.vercel.app` (swap in your actual Vercel
     domain — find it on the Vercel project's dashboard).
   - Under **Redirect URLs**, add both of these so sign-in works in prod
     and in local dev:
     - `https://tds-only-league.vercel.app/auth/callback`
     - `http://localhost:3000/auth/callback`
   The app sends Google back to `/auth/callback` on whatever host it's
   running on, and Supabase only honors redirect targets on this list.
9. Have each of the 8 managers open the app and click **Sign in with
   Google** once. The first authorization creates their account; the first
   8 to sign in are automatically assigned a manager seat (1–8) — no manual
   setup needed. To make an account a commissioner, go to **Table Editor →
   profiles** in Supabase Studio, find that person's row, and set
   `is_commissioner` to `true`.

If something looks wrong after running a migration, open the SQL Editor's
history, check the error message, and re-paste just that one file again —
the migrations are written so re-running a file is safe (they use
`if not exists` / `on conflict do nothing` / `drop ... if exists` where it
matters).

## For developers

- All persistent state flows through Supabase — no localStorage-as-source-
  of-truth. See `docs/ARCHITECTURE.md` for the data model, roles model, and
  conventions later feature work should follow.
- `src/lib/scoring.ts` and `src/lib/roster.ts` are the single source of
  truth for scoring/roster-shape constants in application code — the SQL
  in `supabase/migrations/` mirrors them but is authoritative in the DB via
  a generated column and a trigger.
- `src/components/ui/` holds the shared retro UI primitives
  (`PixelButton`, `PixelPanel`, `Badge`, `ScoreDisplay`) — build feature UI
  out of these rather than one-off styled elements.
- `reference/legacy-prototype/` is the old single-file prototype, kept only
  for cross-checking game logic and ESPN API call shapes. It is not part of
  the running app.
- ESPN sync jobs belong in `supabase/functions/` (Deno Edge Functions) —
  not yet implemented (see `docs/ARCHITECTURE.md`).

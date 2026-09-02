// sync-players
//
// Pulls the whole-league player pool from Tank01 (RapidAPI) and upserts
// QB/RB/WR/TE into `players`, including injury status (the `injury` object
// is embedded on the SAME player-list row — so this one job covers both the
// initial roster pull and the ongoing injury-status refresh; no separate job
// and no getNFLInjuryList call needed). Never falls back to stale/cached
// data on a bad fetch — a failure aborts the run and logs an 'error'
// sync_log row instead.
//
// Quota: one paginated getNFLPlayerList chain (page size 1000, ~3 pages),
// i.e. ~3 API calls per run — replacing the old ESPN shape of 1 team-index
// call + 32 per-team roster calls (33 calls). getPlayerList() throws rather
// than returning a partial pool if pagination doesn't terminate.
//
// Every field read below is verified against the captured response in
// reference/tank01/getNFLPlayerList.sample.json. Do not add a field that
// isn't in that sample.
//
// Invoke: POST (no body needed).
import { getServiceClient, writeSyncLog } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getPlayerList, Tank01Player } from "../_shared/tank01.ts";

// Source of truth for the league's positions is src/lib/roster.ts
// (POSITIONS). It lives in the Vite app and can't be imported from an Edge
// Function bundle, so it's mirrored here. These four values are also the
// entire domain of the `players.position` CHECK constraint in
// supabase/migrations/0001_core.sql — anything else must never reach the
// insert or the whole chunk fails.
const KEEP_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

// The rostered (non-free-agent) QB/RB/WR/TE pool across 32 teams is
// comfortably >200 in practice (roughly 3 QB + 5-6 RB + 6-7 WR + 3 TE per
// team, times 32). Anything under this almost certainly means a partial or
// broken fetch, not a genuinely thin league-wide pool — treat it as a sync
// failure per the "loud staleness / never silently degrade" rule in
// docs/ARCHITECTURE.md.
const MIN_PLAUSIBLE_PLAYER_COUNT = 200;

// Upsert in chunks to keep request bodies reasonable — the pool is 1000+ rows.
const CHUNK = 200;

interface PlayerRow {
  id: string;
  name: string;
  position: string;
  nfl_team: string | null;
  nfl_team_id: string | null;
  status: string;
  status_detail: string | null;
  updated_at: string;
  last_synced_at: string;
  // NOTE: `on_bye` is deliberately ABSENT from this interface and from every
  // row we send. sync-schedule owns that column. PostgREST builds its
  // ON CONFLICT DO UPDATE SET list from the keys present in the payload, so
  // omitting on_bye leaves existing values untouched; including it (even as
  // `false`) would un-bye the entire league on every players run.
}

/**
 * Tank01's `isFreeAgent` is the STRING "True"/"False", never a boolean —
 * `if (p.isFreeAgent)` is truthy for BOTH values and is a bug. Compare the
 * string.
 */
function isFreeAgent(p: Tank01Player): boolean {
  return (p.isFreeAgent ?? "").trim().toLowerCase() === "true";
}

/**
 * Map Tank01's embedded injury object onto status / status_detail.
 *
 * `injury.designation` is one of "" | "Questionable" | "Out" |
 * "Injured Reserve" in the captured data. Empty string means healthy, which
 * maps to 'Active' because the column is NOT NULL. Unrecognised values are
 * passed through as-is rather than silently coerced to 'Active'
 * (status_detail preserves the original text either way).
 */
function normalizeStatus(
  player: Tank01Player,
): { status: string; status_detail: string | null } {
  const raw = (player.injury?.designation ?? "").trim();
  const description = (player.injury?.description ?? "").trim();
  const detail = description.length > 0 ? description : null;

  if (raw.length === 0) {
    // Healthy. Keep any lingering description out of the way so the UI
    // doesn't show an injury note next to an Active player.
    return { status: "Active", status_detail: null };
  }

  const lower = raw.toLowerCase();
  let status = raw;
  if (lower === "questionable") status = "Questionable";
  else if (lower === "doubtful") status = "Doubtful";
  else if (lower === "out") status = "Out";
  else if (lower.includes("injured reserve") || lower === "ir") status = "IR";
  else if (lower === "active") status = "Active";

  return { status, status_detail: detail ?? raw };
}

/** longName is present on every sampled row; fall back to the name parts. */
function playerName(p: Tank01Player): string | null {
  const long = (p.longName ?? "").trim();
  if (long.length > 0) return long;
  const joined = `${(p.firstName ?? "").trim()} ${(p.lastName ?? "").trim()}`
    .trim();
  return joined.length > 0 ? joined : null;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const supabase = getServiceClient();
  const startedAt = Date.now();

  try {
    // Throws on an empty first page or on non-terminating pagination, so a
    // partial pool can never reach the upsert.
    const players = await getPlayerList();

    const now = new Date().toISOString();
    const rows = new Map<string, PlayerRow>();

    let freeAgentsSkipped = 0;
    let wrongPositionSkipped = 0;

    for (const p of players) {
      const pos = (p.pos ?? "").trim().toUpperCase();
      if (!KEEP_POSITIONS.has(pos)) {
        wrongPositionSkipped++;
        continue;
      }

      // Free agents are EXCLUDED from the draftable pool. This is a
      // deliberate choice, not an oversight: Tank01 keeps retired and
      // unsigned players in the list (Philip Rivers is in the captured
      // sample) and they carry a STALE `team`/`teamID` from their last
      // stop, so importing them would put un-signable players on rosters
      // that look real in the draft UI. If the league ever wants
      // free agents draftable, they need a null nfl_team, not this row.
      if (isFreeAgent(p)) {
        freeAgentsSkipped++;
        continue;
      }

      const id = (p.playerID ?? "").trim();
      if (!id) continue;

      const name = playerName(p);
      if (!name) continue;

      const { status, status_detail } = normalizeStatus(p);

      rows.set(id, {
        id, // Tank01 playerID === ESPN athlete id (verified) — no re-keying.
        name,
        position: pos,
        nfl_team: (p.team ?? "").trim() || null,
        nfl_team_id: (p.teamID ?? "").trim() || null,
        status,
        status_detail,
        updated_at: now,
        last_synced_at: now,
      });
    }

    const playerRows = Array.from(rows.values());

    if (playerRows.length < MIN_PLAUSIBLE_PLAYER_COUNT) {
      const msg =
        `Aborting: only parsed ${playerRows.length} QB/RB/WR/TE players from ` +
        `${players.length} Tank01 player rows (${freeAgentsSkipped} free agents ` +
        `skipped) — below the plausibility floor of ${MIN_PLAUSIBLE_PLAYER_COUNT}. ` +
        `Refusing to upsert.`;
      await writeSyncLog(supabase, "players", "error", msg, playerRows.length);
      return jsonResponse({ ok: false, error: msg }, 502);
    }

    // Upsert in chunks to keep request bodies reasonable. `on_bye` is not in
    // the payload, so this never clobbers sync-schedule's bye flags.
    for (let i = 0; i < playerRows.length; i += CHUNK) {
      const chunk = playerRows.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("players")
        .upsert(chunk, { onConflict: "id" });
      if (error) {
        const msg = `Upsert failed at chunk ${i / CHUNK}: ${error.message}`;
        await writeSyncLog(supabase, "players", "error", msg, i);
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    const ms = Date.now() - startedAt;
    const msg =
      `Synced ${playerRows.length} players (QB/RB/WR/TE) from ${players.length} ` +
      `Tank01 player rows in ${ms}ms (${freeAgentsSkipped} free agents skipped, ` +
      `${wrongPositionSkipped} non-QB/RB/WR/TE skipped)`;
    await writeSyncLog(supabase, "players", "success", msg, playerRows.length);

    return jsonResponse({
      ok: true,
      playerCount: playerRows.length,
      sourceRowCount: players.length,
      freeAgentsSkipped,
      wrongPositionSkipped,
      ms,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncLog(supabase, "players", "error", msg, null);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

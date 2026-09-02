// sync-scores
//
// For the current/target stage, lists that week's games from Tank01
// (getNFLGamesForWeek), fetches the box score of each game that can still
// change, and tallies pass_td / rush_td / rec_td per player into
// player_stage_stats.
//
// Parsing approach (Tank01 shape — verified against
// reference/tank01/getNFLBoxScore.sample.json)
// ------------------------------------------------------------------------
// getNFLBoxScore returns `playerStats`, an OBJECT KEYED BY playerID. Each
// value carries at most one object per stat category the player recorded:
//
//   "15835": { playerID: "15835", longName: "Zach Ertz", teamAbv: "WSH",
//              Receiving: { recTD: "1", recYds: "40", ... } }
//
// Every value is a STRING, and a category object is simply ABSENT when the
// player recorded nothing in it (Ertz above has no Passing/Rushing key).
// tdsFor() in _shared/tank01.ts does the parsing — it reads exactly
// Passing.passTD / Rushing.rushTD / Receiving.recTD and deliberately ignores
// Defense.defTD and the return-TD fields, which this league does not score.
// Do not re-implement that here.
//
// A passing TD and its receiving TD are separate rows keyed by separate
// playerIDs, so the QB and the receiver are each credited without any
// play-by-play text parsing.
//
// Quota discipline
// ------------------------------------------------------------------------
// Tank01 Pro is 1,000 calls/day, so this function refuses to re-fetch a box
// score that cannot have changed: games that have not kicked off yet have no
// stats, and final games are frozen. See shouldFetch() below.
//
// This is safe with a partial-week upsert because an NFL player appears in
// at most ONE game per stage — so the per-player rows produced by fetched
// games and by skipped games are disjoint. Upserting only the players we saw
// this run therefore never clobbers a skipped game's already-stored TDs.
//
// Invoke: POST { "stage_id"?: number }
import { getServiceClient, writeSyncLog } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import {
  getBoxScore,
  getGamesForWeek,
  hasAnyTd,
  isFinal,
  isScheduled,
  kickoffAt,
  mapWithConcurrency,
  type Tank01Game,
  tdsFor,
  type TdTally,
} from "../_shared/tank01.ts";
import {
  currentSeason,
  isAddressable,
  resolveStage,
  unaddressedStageMessage,
} from "../_shared/stage.ts";

const GAME_FETCH_CONCURRENCY = 4;

/**
 * Generous upper bound on how long after kickoff a game can still be
 * producing stats (regulation + overtime + stat settling). Used only to
 * decide whether a previous successful run definitely saw this game's final
 * box score; see shouldFetch().
 */
const GAME_SETTLED_MS = 6 * 60 * 60 * 1000;

/**
 * Timestamp of the last sync-scores run that fetched every game cleanly.
 *
 * IMPORTANT LIMITATION: `sync_log` records a source but not a stage, so this
 * watermark is GLOBAL, not per-stage. A clean run for Week 5 would otherwise
 * make every already-final Week 3 game look "already ingested" — which would
 * silently turn a commissioner's explicit re-run of an earlier week into a
 * no-op, breaking the one manual path for repairing bad scores. Callers must
 * therefore skip this watermark entirely whenever an explicit stage_id was
 * requested; see the call site.
 */
// deno-lint-ignore no-explicit-any
async function lastCleanRunAt(supabase: any): Promise<Date | null> {
  const { data, error } = await supabase
    .from("sync_log")
    .select("ran_at")
    .eq("source", "scores")
    .eq("status", "success")
    .order("ran_at", { ascending: false })
    .limit(1);
  // A logging-table hiccup must not stop scores from syncing; without a
  // watermark we simply fetch more games than strictly necessary.
  if (error || !data || data.length === 0) return null;
  const d = new Date(data[0].ran_at);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface SkipDecision {
  fetch: boolean;
  reason: "scheduled" | "final-already-ingested" | "live" | "final-unseen";
}

/**
 * Decide whether this game's box score can still tell us something new.
 *
 * - Not kicked off  -> no stats exist yet. Never fetch.
 * - Final           -> stats are frozen, so fetch it exactly once: skip only
 *                      when a previous run that fetched EVERY game cleanly
 *                      happened well after this game must have ended. (A run
 *                      with any failed fetch logs status 'error' and so never
 *                      advances this watermark — deliberately conservative.)
 * - Anything else   -> in progress / delayed / unknown. Fetch.
 */
function shouldFetch(game: Tank01Game, lastClean: Date | null): SkipDecision {
  if (isScheduled(game)) return { fetch: false, reason: "scheduled" };
  if (!isFinal(game)) return { fetch: true, reason: "live" };

  const kickoff = kickoffAt(game);
  if (
    lastClean && kickoff &&
    lastClean.getTime() > kickoff.getTime() + GAME_SETTLED_MS
  ) {
    return { fetch: false, reason: "final-already-ingested" };
  }
  return { fetch: true, reason: "final-unseen" };
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const supabase = getServiceClient();

  let body: { stage_id?: number } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json().catch(() => ({}));
    }
  } catch {
    body = {};
  }

  try {
    const stage = await resolveStage(supabase, body.stage_id);

    // Week addressing lives entirely in _shared/stage.ts: `season_type` and
    // `week_num` on the stage row (null for the four postseason stages whose
    // Tank01 numbering was never confirmed) plus currentSeason() for the year.
    // Those three reads are the only stages columns this function knows about.
    if (!isAddressable(stage)) {
      const msg = unaddressedStageMessage(stage);
      await writeSyncLog(supabase, "scores", "error", msg, null);
      return jsonResponse(
        { ok: false, error: msg, stageId: stage.id, stageName: stage.name },
        422,
      );
    }
    const season = currentSeason();

    const games = await getGamesForWeek(
      stage.week_num,
      stage.season_type,
      season,
    );

    if (games.length === 0) {
      const msg = `Tank01 getNFLGamesForWeek for ${stage.name} ` +
        `(week=${stage.week_num}, seasonType="${stage.season_type}", season=${season}) ` +
        `returned zero games — nothing to sync.`;
      await writeSyncLog(supabase, "scores", "error", msg, null);
      return jsonResponse({ ok: false, error: msg }, 502);
    }

    // An explicit stage_id means a human is deliberately re-syncing a
    // specific week, almost always to repair it. Honour that by re-fetching
    // every playable game instead of trusting the (stage-blind) watermark,
    // which would otherwise skip the whole week as already ingested.
    const isExplicitRerun = body.stage_id !== undefined &&
      body.stage_id !== null;
    const lastClean = isExplicitRerun ? null : await lastCleanRunAt(supabase);
    const toFetch: Tank01Game[] = [];
    let skippedScheduled = 0;
    let skippedFinal = 0;
    for (const game of games) {
      const decision = shouldFetch(game, lastClean);
      if (decision.fetch) toFetch.push(game);
      else if (decision.reason === "scheduled") skippedScheduled++;
      else skippedFinal++;
    }

    // Every player who appeared in a fetched game, keyed by playerID (which
    // IS players.id — verified in the player-list sample). Players with zero
    // TDs are kept deliberately: writing their zeros back is what corrects a
    // TD that was credited live and later reversed by a stat correction.
    const tallies = new Map<string, TdTally>();

    const { results, errors } = await mapWithConcurrency(
      toFetch,
      GAME_FETCH_CONCURRENCY,
      async (game: Tank01Game) => {
        const box = await getBoxScore(game.gameID);
        const playerStats = box.playerStats;
        if (!playerStats || typeof playerStats !== "object") {
          throw new Error(`game ${game.gameID} box score has no playerStats`);
        }
        for (const [playerId, stats] of Object.entries(playerStats)) {
          if (!playerId || !stats) continue;
          const t = tdsFor(stats);
          const existing = tallies.get(playerId);
          if (!existing) {
            tallies.set(playerId, t);
          } else {
            // Defensive: a player appears in exactly one game per stage, so
            // this only fires if Tank01 lists a game twice.
            existing.pass_td += t.pass_td;
            existing.rush_td += t.rush_td;
            existing.rec_td += t.rec_td;
          }
        }
        return game.gameID;
      },
    );

    if (errors.length > 0) {
      console.error(
        `sync-scores: ${errors.length}/${toFetch.length} box score fetches failed`,
        errors.map((e) => String(e.error)),
      );
    }

    // Only upsert players that already exist in our `players` table
    // (skip unknowns rather than violate the FK / invent player rows here
    // — sync-players is the source of truth for the player pool). Most of
    // the skips are defenders, kickers and linemen, who are unrosterable.
    const playerIds = Array.from(tallies.keys());
    const knownIds = new Set<string>();
    const ID_CHUNK = 500;
    for (let i = 0; i < playerIds.length; i += ID_CHUNK) {
      const chunk = playerIds.slice(i, i + ID_CHUNK);
      const { data, error } = await supabase
        .from("players")
        .select("id")
        .in("id", chunk);
      if (error) throw new Error(`players lookup failed: ${error.message}`);
      for (const row of data ?? []) knownIds.add(row.id as string);
    }

    const now = new Date().toISOString();
    // NOTE: `points` is a GENERATED column on player_stage_stats — never
    // write it here; Postgres computes it from the three TD counts.
    const rows = playerIds
      .filter((id) => knownIds.has(id))
      .map((id) => {
        const t = tallies.get(id)!;
        return {
          stage_id: stage.id,
          player_id: id,
          pass_td: t.pass_td,
          rush_td: t.rush_td,
          rec_td: t.rec_td,
          updated_at: now,
        };
      });
    const skippedCount = playerIds.length - rows.length;
    const scorers = rows.filter((r) =>
      hasAnyTd({ pass_td: r.pass_td, rush_td: r.rush_td, rec_td: r.rec_td })
    ).length;

    if (rows.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("player_stage_stats")
          .upsert(chunk, { onConflict: "stage_id,player_id" });
        if (error) {
          throw new Error(
            `player_stage_stats upsert failed at chunk ${
              i / CHUNK
            }: ${error.message}`,
          );
        }
      }
    }

    const status = errors.length > 0 ? "error" : "success";
    const msg =
      `Stage "${stage.name}": fetched ${results.length}/${toFetch.length} ` +
      `box scores of ${games.length} games ` +
      `(skipped ${skippedFinal} already-final, ${skippedScheduled} not yet kicked off). ` +
      `Tallied ${playerIds.length} players, ${scorers} with TDs, upserted ${rows.length} ` +
      `(${skippedCount} skipped — not in players table). ` +
      (errors.length > 0
        ? `${errors.length} box score fetch(es) FAILED — stats for those games are missing this run.`
        : "All fetched games succeeded.");
    await writeSyncLog(supabase, "scores", status, msg, rows.length);

    return jsonResponse({
      ok: errors.length === 0,
      stageId: stage.id,
      stageName: stage.name,
      week: stage.week_num,
      seasonType: stage.season_type,
      season,
      gamesInWeek: games.length,
      gamesFetched: results.length,
      gamesFailed: errors.length,
      gamesSkippedFinal: skippedFinal,
      gamesSkippedScheduled: skippedScheduled,
      playersTallied: playerIds.length,
      playersWithTds: scorers,
      playersUpserted: rows.length,
      skippedUnknownPlayers: skippedCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncLog(supabase, "scores", "error", msg, null);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

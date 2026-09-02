// sync-schedule
//
// For the current/target stage (see _shared/stage.ts for the selection rule):
//   (a) writes the earliest kickoff of that week to stages.first_kickoff_at
//       — this is what apply-locks uses to auto-lock rosters.
//   (b) sets players.on_bye for every player, based on which teams are on
//       bye that week.
//
// WHAT CHANGED IN THE TANK01 MIGRATION
// ---------------------------------------------------------------------------
// Byes used to be *derived*: fetch the week's games, collect the team ids that
// appear, and treat the other 32-N as on bye. That inferred a bye from an
// absence, so any week the schedule came back short — a partial fetch, a
// postponed game, an API hiccup — silently benched real players.
//
// Tank01 publishes byes directly: every team in getNFLTeams carries a
// `byeWeeks` map keyed by season year. So we now read the bye instead of
// inferring it, and a short/failed schedule response can no longer masquerade
// as "everyone's on bye". See reference/tank01/getNFLTeams.sample.json.
//
// Kickoff comes from each game's `gameTime_epoch` (unix seconds), which is
// unambiguous — unlike a local time string, it needs no timezone guessing.
//
// Invoke: POST { "stage_id"?: number }
import { getServiceClient, writeSyncLog } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import {
  byeWeeksFor,
  getGamesForWeek,
  getTeams,
  kickoffAt,
} from "../_shared/tank01.ts";
import {
  currentSeason,
  isAddressable,
  resolveStage,
  unaddressedStageMessage,
} from "../_shared/stage.ts";

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

    // The four postseason stages ship without confirmed Tank01 week
    // addressing. Skipping loudly beats sending week=null and getting an
    // empty result that looks like a real, gameless week.
    if (!isAddressable(stage)) {
      const msg = unaddressedStageMessage(stage);
      await writeSyncLog(supabase, "schedule", "error", msg, null);
      return jsonResponse({ ok: false, error: msg, stageId: stage.id }, 422);
    }

    const season = currentSeason();

    const [games, teams] = await Promise.all([
      getGamesForWeek(stage.week_num, stage.season_type, season),
      getTeams(),
    ]);

    if (games.length === 0) {
      const msg = `getNFLGamesForWeek(week=${stage.week_num}, ` +
        `seasonType=${stage.season_type}, season=${season}) returned zero ` +
        `games for stage "${stage.name}" — refusing to write first_kickoff_at ` +
        `or bye flags off an empty week. If this stage is correctly addressed, ` +
        `check the seasonType value against a real response.`;
      await writeSyncLog(supabase, "schedule", "error", msg, null);
      return jsonResponse({ ok: false, error: msg }, 502);
    }

    // ---- (a) earliest kickoff this week --------------------------------
    let earliest: Date | null = null;
    let undatedGames = 0;
    for (const game of games) {
      const at = kickoffAt(game);
      if (!at) {
        undatedGames++;
        continue;
      }
      if (!earliest || at < earliest) earliest = at;
    }

    if (earliest) {
      const { error } = await supabase
        .from("stages")
        .update({ first_kickoff_at: earliest.toISOString() })
        .eq("id", stage.id);
      if (error) throw new Error(`stages update failed: ${error.message}`);
    }

    // ---- (b) bye teams, read straight from the team payload -------------
    // A team is on bye for this stage when this stage's week number appears
    // in that team's byeWeeks for the season.
    const byeTeamIds: string[] = [];
    const activeTeamIds: string[] = [];
    for (const team of teams) {
      const byes = byeWeeksFor(team, season);
      (byes.includes(stage.week_num) ? byeTeamIds : activeTeamIds).push(
        String(team.teamID),
      );
    }

    // Sanity guard. A normal NFL week has at most a handful of teams on bye;
    // if the bye data ever comes back malformed enough to bench most of the
    // league, that is a bug, not a bye week — refuse rather than wipe the
    // player pool's availability.
    const MAX_PLAUSIBLE_BYE_TEAMS = 8;
    if (byeTeamIds.length > MAX_PLAUSIBLE_BYE_TEAMS) {
      const msg =
        `Refusing to flag ${byeTeamIds.length} teams on bye for stage ` +
        `"${stage.name}" (week ${stage.week_num}, season ${season}); more than ` +
        `${MAX_PLAUSIBLE_BYE_TEAMS} is implausible and suggests bad byeWeeks ` +
        `data rather than a real bye week.`;
      await writeSyncLog(supabase, "schedule", "error", msg, null);
      return jsonResponse({ ok: false, error: msg }, 502);
    }

    const now = new Date().toISOString();
    if (byeTeamIds.length > 0) {
      const { error } = await supabase
        .from("players")
        .update({ on_bye: true, updated_at: now })
        .in("nfl_team_id", byeTeamIds);
      if (error) {
        throw new Error(`players on_bye=true update failed: ${error.message}`);
      }
    }
    if (activeTeamIds.length > 0) {
      const { error } = await supabase
        .from("players")
        .update({ on_bye: false, updated_at: now })
        .in("nfl_team_id", activeTeamIds);
      if (error) {
        throw new Error(`players on_bye=false update failed: ${error.message}`);
      }
    }

    const msg =
      `Stage "${stage.name}" (week ${stage.week_num}, ${stage.season_type}, ` +
      `season ${season}): first_kickoff_at=${
        earliest?.toISOString() ?? "null"
      }, ` +
      `${byeTeamIds.length} team(s) on bye (${
        byeTeamIds.join(", ") || "none"
      }), ` +
      `${games.length} game(s) this week` +
      (undatedGames > 0 ? `, ${undatedGames} without a kickoff time` : "") +
      ".";
    await writeSyncLog(supabase, "schedule", "success", msg, null);

    return jsonResponse({
      ok: true,
      stageId: stage.id,
      stageName: stage.name,
      season,
      weekNum: stage.week_num,
      seasonType: stage.season_type,
      firstKickoffAt: earliest?.toISOString() ?? null,
      byeTeamIds,
      gameCount: games.length,
      undatedGames,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeSyncLog(supabase, "schedule", "error", msg, null);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

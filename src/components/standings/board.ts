import { getRosterPicks, getWeeklyResults } from "@/lib/db";
import { getStagePlayerStats } from "./queries";
import { computePoints } from "@/lib/scoring";
import type { Player, Stage } from "@/lib/types";
import type { StandingsRow } from "./StandingsTable";
import type { ManagerBoxScore } from "./BoxScore";

/**
 * One stage's standings plus every manager's roster breakdown — the unit the
 * league page renders over and over (this week, and each past week).
 *
 * A finalized stage reads its ranks and totals from weekly_results, which the
 * commissioner's finalize action froze. Any other stage is computed live from
 * roster_picks x player_stage_stats, so points move as scores sync in. Both
 * shapes come back identical so callers never branch on stage status.
 */
export interface StageBoard {
  stage: Stage;
  rows: StandingsRow[];
  /** Keyed by manager id — the roster shown when a standings row is expanded. */
  boxesByManager: Map<string, ManagerBoxScore>;
  /** True when totals are still moving (drafted-and-locked, not yet finalized). */
  live: boolean;
}

export async function loadStageBoard(
  stage: Stage,
  nameByManagerId: Map<string, string>,
  playerById: Map<string, Player>,
): Promise<StageBoard> {
  const finalized = stage.status === "finalized";

  const [picks, stats, results] = await Promise.all([
    getRosterPicks(stage.id),
    getStagePlayerStats(stage.id),
    finalized ? getWeeklyResults(stage.id) : Promise.resolve([]),
  ]);

  const statsByPlayerId = new Map(stats.map((s) => [s.player_id, s]));

  // Build each manager's roster breakdown first — it is the same work whether
  // the stage is final or live, since per-player TDs are never re-frozen.
  const boxesByManager = new Map<string, ManagerBoxScore>();
  for (const pick of picks) {
    const box = boxesByManager.get(pick.manager_id) ?? {
      managerId: pick.manager_id,
      managerName: nameByManagerId.get(pick.manager_id) ?? "Manager",
      rank: null,
      totalPoints: 0,
      players: [],
    };

    const player = playerById.get(pick.player_id);
    const stat = statsByPlayerId.get(pick.player_id);
    const tds = stat ? stat.pass_td + stat.rush_td + stat.rec_td : 0;
    const points = stat
      ? computePoints({
        passTd: stat.pass_td,
        rushTd: stat.rush_td,
        recTd: stat.rec_td,
      })
      : 0;

    box.players.push({
      playerId: pick.player_id,
      name: player?.name ?? "Unknown player",
      position: pick.slot_position,
      tds,
      points,
    });
    box.totalPoints += points;
    boxesByManager.set(pick.manager_id, box);
  }

  let rows: StandingsRow[];

  if (finalized && results.length > 0) {
    rows = results.map((r) => ({
      managerId: r.manager_id,
      name: nameByManagerId.get(r.manager_id) ?? "Manager",
      rank: r.rank,
      points: r.total_points,
      tds: r.total_tds,
    }));
  } else {
    // Every manager gets a row, including ones whose players have not scored,
    // so the table is a full league snapshot rather than only the scorers.
    const totals = new Map<string, { points: number; tds: number }>();
    for (const [managerId, name] of nameByManagerId) {
      void name;
      totals.set(managerId, { points: 0, tds: 0 });
    }
    for (const pick of picks) {
      const entry = totals.get(pick.manager_id) ?? { points: 0, tds: 0 };
      const stat = statsByPlayerId.get(pick.player_id);
      if (stat) {
        entry.points += computePoints({
          passTd: stat.pass_td,
          rushTd: stat.rush_td,
          recTd: stat.rec_td,
        });
        entry.tds += stat.pass_td + stat.rush_td + stat.rec_td;
      }
      totals.set(pick.manager_id, entry);
    }

    rows = Array.from(totals.entries()).map(([managerId, t]) => ({
      managerId,
      name: nameByManagerId.get(managerId) ?? "Manager",
      rank: null,
      points: t.points,
      tds: t.tds,
    }));
    rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    rows.forEach((row, i) => {
      row.rank = i + 1;
    });
  }

  // Rank is only known after the rows are ordered, so stamp the boxes here.
  for (const row of rows) {
    const box = boxesByManager.get(row.managerId);
    if (box) box.rank = row.rank;
  }

  return {
    stage,
    rows,
    boxesByManager,
    live: !finalized,
  };
}

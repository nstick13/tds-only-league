import { PixelPanel } from "@/components/ui/PixelPanel";
import { Badge } from "@/components/ui/Badge";
import { ScoreDisplay } from "@/components/ui/ScoreDisplay";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStage, getMyRoster, getPlayers } from "@/lib/db";
import { POSITIONS, ROSTER_SHAPE, type Position } from "@/lib/roster";
import type { PlayerStageStats } from "@/lib/types";

const SLOT_ORDER: Position[] = POSITIONS.flatMap((pos) =>
  Array.from({ length: ROSTER_SHAPE[pos] }, () => pos),
);

/**
 * /my-roster — the signed-in manager's roster for the current stage: the
 * Slots laid out by ROSTER_SHAPE, each filled slot showing the player's
 * team/status/bye, plus live points once player_stage_stats exist for the
 * stage (player_stage_stats isn't in the shared src/lib/db barrel, so it's
 * queried locally here).
 */
export default async function MyRosterPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const stage = await getCurrentStage();

  if (!stage) {
    return (
      <PixelPanel raised className="flex flex-col gap-3 items-center text-center py-12">
        <h1 className="font-pixel text-lg text-retro-yellow">My Roster</h1>
        <p className="font-mono text-lg text-retro-offwhite/80">
          The season is over — no active stage.
        </p>
      </PixelPanel>
    );
  }

  if (!user) {
    return (
      <PixelPanel raised className="flex flex-col gap-3 items-center text-center py-12">
        <h1 className="font-pixel text-lg text-retro-yellow">My Roster</h1>
        <p className="font-mono text-lg text-retro-offwhite/80">Sign in to view your roster.</p>
      </PixelPanel>
    );
  }

  const [myPicks, allPlayers] = await Promise.all([
    getMyRoster(stage.id),
    getPlayers(),
  ]);

  const playersById = new Map(allPlayers.map((p) => [p.id, p]));

  let statsByPlayerId = new Map<string, PlayerStageStats>();
  if (myPicks.length > 0) {
    const { data: stats } = await supabase
      .from("player_stage_stats")
      .select("*")
      .eq("stage_id", stage.id)
      .in(
        "player_id",
        myPicks.map((p) => p.player_id),
      );
    statsByPlayerId = new Map((stats ?? []).map((s) => [s.player_id as string, s as PlayerStageStats]));
  }

  const totalPoints = myPicks.reduce((sum, pick) => {
    const stat = statsByPlayerId.get(pick.player_id);
    return sum + (stat?.points ?? 0);
  }, 0);

  const hasStats = statsByPlayerId.size > 0;
  const usedByPosition: Partial<Record<Position, number>> = {};

  return (
    <div className="flex flex-col gap-4">
      <PixelPanel raised className="flex flex-col items-center gap-2 py-6">
        <h1 className="font-pixel text-lg text-retro-yellow">My Roster</h1>
        <p className="font-mono text-lg text-retro-offwhite/70 uppercase">{stage.name}</p>
        {hasStats ? (
          <ScoreDisplay value={totalPoints.toFixed(1)} label="Total Points" size="lg" />
        ) : (
          <p className="font-mono text-base text-retro-offwhite/50 uppercase">
            {stage.status === "draft_open" ? "Draft in progress" : "No stats yet"}
          </p>
        )}
      </PixelPanel>

      <PixelPanel raised className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {SLOT_ORDER.map((pos, slotIdx) => {
            const occurrence = usedByPosition[pos] ?? 0;
            const matches = myPicks.filter((p) => p.slot_position === pos);
            const pick = matches[occurrence];
            usedByPosition[pos] = occurrence + 1;
            const player = pick ? playersById.get(pick.player_id) : undefined;
            const stat = pick ? statsByPlayerId.get(pick.player_id) : undefined;

            return (
              <li
                key={`${pos}-${slotIdx}`}
                className="flex items-center justify-between gap-3 border-2 border-retro-offwhite/40 bg-field px-3 py-3"
              >
                <span className="font-pixel text-xs text-retro-yellow w-10 shrink-0">
                  {pos}
                </span>
                {player ? (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-lg text-retro-offwhite truncate">
                          {player.name}
                        </span>
                        <span className="font-mono text-base text-retro-offwhite/60">
                          {player.nfl_team ?? "FA"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {player.status && player.status !== "Active" ? (
                          <Badge
                            status={
                              (["Questionable", "Doubtful", "OUT", "IR"] as const).includes(
                                player.status as "Questionable" | "Doubtful" | "OUT" | "IR",
                              )
                                ? (player.status as "Questionable" | "Doubtful" | "OUT" | "IR")
                                : "OUT"
                            }
                          />
                        ) : null}
                        {player.on_bye ? <Badge status="Bye" /> : null}
                      </div>
                    </div>
                    {stat ? (
                      <span className="font-pixel text-sm text-retro-green shrink-0">
                        {stat.points.toFixed(1)}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="flex-1 font-mono text-lg text-retro-offwhite/30 italic">
                    — empty slot —
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PixelPanel>
    </div>
  );
}

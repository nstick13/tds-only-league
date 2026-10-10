"use client";

import { PixelPanel } from "@/components/ui/PixelPanel";
import { Badge } from "@/components/ui/Badge";
import type { Player, Profile, RosterPick } from "@/lib/types";
import { POSITIONS, ROSTER_SHAPE, type Position } from "@/lib/roster";

export interface TeamRostersProps {
  managers: Profile[];
  picks: RosterPick[];
  playersById: Map<string, Player>;
  currentUserId: string | null;
  /**
   * SNF + MNF guesses the viewer is allowed to see, by manager id. Before
   * kickoff RLS only returns the viewer's own; omit to hide the line.
   */
  guessByManager?: Map<string, number>;
  /** True once guesses are unsealed (kickoff passed / stage locked). */
  guessesRevealed?: boolean;
}

/** Flat list of every roster slot in display order, e.g. [QB, RB, RB, WR, WR, TE]. */
const SLOT_ORDER: Position[] = POSITIONS.flatMap((pos) =>
  Array.from({ length: ROSTER_SHAPE[pos] }, () => pos),
);

/** Live grid of every manager's roster-in-progress, updated on realtime pick events. */
export function TeamRosters({
  managers,
  picks,
  playersById,
  currentUserId,
  guessByManager,
  guessesRevealed = false,
}: TeamRostersProps) {
  return (
    <PixelPanel raised className="flex flex-col gap-3">
      <h2 className="font-pixel text-xs text-retro-yellow">Team Rosters</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {managers.map((manager) => {
          const managerPicks = picks.filter((p) => p.manager_id === manager.id);
          const isMe = manager.id === currentUserId;
          // Track how many of each position have been rendered already, so
          // the Nth QB pick fills the Nth QB slot.
          const usedByPosition: Partial<Record<Position, number>> = {};

          return (
            <div
              key={manager.id}
              className={[
                "border-2 p-2",
                isMe ? "border-retro-yellow" : "border-retro-offwhite/30",
              ].join(" ")}
            >
              <p className="font-pixel text-[10px] text-retro-offwhite mb-1 truncate">
                {manager.display_name ?? "Manager"}
                {isMe ? " (You)" : ""}
              </p>
              <ul className="flex flex-col gap-0.5">
                {SLOT_ORDER.map((pos, slotIdx) => {
                  const occurrence = usedByPosition[pos] ?? 0;
                  const matches = managerPicks.filter((p) => p.slot_position === pos);
                  const pick = matches[occurrence];
                  usedByPosition[pos] = occurrence + 1;
                  const player = pick ? playersById.get(pick.player_id) : undefined;

                  return (
                    <li
                      key={`${pos}-${slotIdx}`}
                      className="flex items-center justify-between gap-2 font-mono text-base"
                    >
                      <span className="text-retro-offwhite/50 w-8 shrink-0">{pos}</span>
                      {player ? (
                        <span className="flex-1 flex items-center gap-1 min-w-0">
                          <span className="text-retro-offwhite truncate">{player.name}</span>
                          {player.on_bye ? <Badge status="Bye" /> : null}
                        </span>
                      ) : (
                        <span className="flex-1 text-retro-offwhite/30 italic">— empty —</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {guessByManager ? (
                <p className="font-mono text-base mt-1 pt-1 border-t border-retro-offwhite/20 flex justify-between gap-2">
                  <span className="text-retro-offwhite/50">SNF+MNF</span>
                  {guessByManager.has(manager.id) ? (
                    <span className="text-retro-yellow">{guessByManager.get(manager.id)}</span>
                  ) : (
                    <span className="text-retro-offwhite/30 italic">
                      {isMe || guessesRevealed ? "no guess" : "sealed"}
                    </span>
                  )}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </PixelPanel>
  );
}

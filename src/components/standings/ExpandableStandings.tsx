"use client";

import { useState } from "react";
import { RankBadge } from "./RankBadge";
import { BoxScore, type ManagerBoxScore } from "./BoxScore";
import type { StandingsRow } from "./StandingsTable";

export interface ExpandableStandingsProps {
  rows: StandingsRow[];
  /** Manager id -> that manager's roster breakdown. A row with no entry still renders, just without a caret. */
  boxesByManager: Map<string, ManagerBoxScore>;
  pointsLabel?: string;
}

/**
 * Column template shared by the header and every row. A <table> can't express
 * this layout: each row is a disclosure whose expanded roster must span the
 * full width, and a colSpan cell with its own grid would stop lining up with
 * the header. One grid template applied to both keeps the columns honest.
 */
const COLUMNS = "grid grid-cols-[auto_1fr_2.5rem_4.5rem] items-center gap-3";

/**
 * Standings where each manager row expands to show that manager's roster for
 * the stage. StandingsTable stays as-is for the season leaderboard, which has
 * no single-stage roster to drill into.
 *
 * The whole row is the toggle, not just the caret — this is read on a phone
 * during games, so the tap target is the full width.
 */
export function ExpandableStandings({
  rows,
  boxesByManager,
  pointsLabel = "PTS",
}: ExpandableStandingsProps) {
  const [openManagerIds, setOpenManagerIds] = useState<ReadonlySet<string>>(new Set());

  if (rows.length === 0) {
    return (
      <p className="font-mono text-retro-offwhite/70 text-center py-6">
        No standings to show yet.
      </p>
    );
  }

  const toggle = (managerId: string) => {
    setOpenManagerIds((prev) => {
      const next = new Set(prev);
      if (next.has(managerId)) next.delete(managerId);
      else next.add(managerId);
      return next;
    });
  };

  return (
    <div className="font-mono text-base">
      <div
        className={`${COLUMNS} border-b-2 border-retro-offwhite/40 pb-2 uppercase font-pixel text-[10px] text-retro-offwhite/70`}
      >
        <span>Rank</span>
        <span>Manager</span>
        <span className="text-right">TDs</span>
        <span className="text-right">{pointsLabel}</span>
      </div>

      {rows.map((row) => {
        const box = boxesByManager.get(row.managerId);
        const isOpen = openManagerIds.has(row.managerId);
        const panelId = `roster-${row.managerId}`;

        return (
          <div key={row.managerId} className="border-b border-retro-offwhite/20">
            <button
              type="button"
              onClick={() => box && toggle(row.managerId)}
              disabled={!box}
              aria-expanded={box ? isOpen : undefined}
              aria-controls={box ? panelId : undefined}
              className={`${COLUMNS} w-full py-2 text-left ${
                box ? "cursor-pointer hover:bg-retro-offwhite/10" : "cursor-default"
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`font-pixel text-[10px] text-retro-yellow transition-transform ${
                    isOpen ? "rotate-90" : ""
                  } ${box ? "" : "invisible"}`}
                >
                  &#9654;
                </span>
                <RankBadge rank={row.rank} />
              </span>
              <span className="flex flex-col min-w-0">
                <span className="truncate">{row.name}</span>
                {row.detail ? (
                  <span className="font-mono text-xs text-retro-offwhite/60 truncate">
                    {row.detail}
                  </span>
                ) : null}
              </span>
              <span className="text-right tabular-nums">{row.tds}</span>
              <span className="text-right font-bold text-retro-yellow tabular-nums">
                {row.points.toFixed(1)}
              </span>
            </button>

            {box && isOpen ? (
              <div id={panelId} className="pb-3">
                <BoxScore box={box} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

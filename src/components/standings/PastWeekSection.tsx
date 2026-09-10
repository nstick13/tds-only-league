"use client";

import { useState } from "react";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { ExpandableStandings } from "./ExpandableStandings";
import type { ManagerBoxScore } from "./BoxScore";
import type { StandingsRow } from "./StandingsTable";

export interface PastWeekSectionProps {
  stageName: string;
  /** Manager who won the stage, shown in the collapsed header so the week is readable without opening it. */
  winnerName: string | null;
  winnerPoints: number | null;
  rows: StandingsRow[];
  boxesByManager: Map<string, ManagerBoxScore>;
}

/**
 * One finalized week on the league page: collapsed to a headline row, and
 * expanded to that week's full standings — whose rows in turn expand to each
 * manager's roster. Two levels of caret, which is why the week header carets
 * are visually heavier than the manager ones.
 *
 * Collapsed by default: by Week 10 this list is long, and the current week
 * above it is what people actually came to look at.
 */
export function PastWeekSection({
  stageName,
  winnerName,
  winnerPoints,
  rows,
  boxesByManager,
}: PastWeekSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = `week-${stageName.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <PixelPanel className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 text-left"
      >
        <span
          aria-hidden="true"
          className={`font-pixel text-xs text-retro-yellow transition-transform ${
            isOpen ? "rotate-90" : ""
          }`}
        >
          &#9654;
        </span>
        <span className="font-pixel text-sm text-retro-yellow">{stageName}</span>
        {winnerName ? (
          <span className="ml-auto font-mono text-sm text-retro-offwhite/80">
            {winnerName} &middot;{" "}
            <span className="text-retro-yellow">{winnerPoints?.toFixed(1)}</span>
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div id={panelId}>
          <ExpandableStandings rows={rows} boxesByManager={boxesByManager} />
        </div>
      ) : null}
    </PixelPanel>
  );
}

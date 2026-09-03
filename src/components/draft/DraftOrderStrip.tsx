"use client";

import { useEffect, useRef } from "react";
import { PixelPanel } from "@/components/ui/PixelPanel";
import type { DraftOrderRow, Profile } from "@/lib/types";

export interface DraftOrderStripProps {
  draftOrder: DraftOrderRow[];
  managers: Profile[];
  currentPickNumber: number | null;
  currentUserId: string | null;
}

function nameFor(managers: Profile[], managerId: string | null): string {
  if (!managerId) return "TBD";
  const manager = managers.find((m) => m.id === managerId);
  return manager?.display_name ?? "Unknown";
}

/** ON THE CLOCK banner + a scrollable strip of the full 48-pick snake order. */
export function DraftOrderStrip({
  draftOrder,
  managers,
  currentPickNumber,
  currentUserId,
}: DraftOrderStripProps) {
  const onTheClock =
    currentPickNumber !== null
      ? draftOrder.find((r) => r.pick_number === currentPickNumber)
      : undefined;

  const isMe = onTheClock?.manager_id === currentUserId;

  const stripRef = useRef<HTMLDivElement>(null);
  const currentPickRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    currentPickRef.current?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }, [currentPickNumber]);

  return (
    <PixelPanel raised className="flex flex-col gap-3">
      <div className="text-center">
        {currentPickNumber === null ? (
          <p className="font-pixel text-sm text-retro-green">Draft complete!</p>
        ) : (
          <>
            <p className="font-mono text-base text-retro-offwhite/70 uppercase">
              Pick #{currentPickNumber}
            </p>
            <p
              className={[
                "font-pixel text-base sm:text-lg",
                isMe ? "text-retro-green animate-pulse" : "text-retro-yellow",
              ].join(" ")}
            >
              {isMe
                ? "ON THE CLOCK: YOU!"
                : `ON THE CLOCK: ${nameFor(managers, onTheClock?.manager_id ?? null)}`}
            </p>
          </>
        )}
      </div>

      <div ref={stripRef} className="flex gap-1 overflow-x-auto pb-1">
        {draftOrder.map((row) => {
          const isCurrent = row.pick_number === currentPickNumber;
          const isPast =
            currentPickNumber !== null && row.pick_number < currentPickNumber;
          return (
            <div
              key={row.pick_number}
              ref={isCurrent ? currentPickRef : undefined}
              className={[
                "flex flex-col items-center justify-center shrink-0 w-16 h-14 border-2 px-1",
                isCurrent
                  ? "border-retro-yellow bg-retro-yellow text-field"
                  : isPast
                    ? "border-retro-offwhite/20 bg-field-dark text-retro-offwhite/40"
                    : "border-retro-offwhite/40 bg-field text-retro-offwhite",
              ].join(" ")}
              title={nameFor(managers, row.manager_id)}
            >
              <span className="font-pixel text-[9px]">#{row.pick_number}</span>
              <span className="font-mono text-[11px] truncate w-full text-center">
                {nameFor(managers, row.manager_id)}
              </span>
            </div>
          );
        })}
      </div>
    </PixelPanel>
  );
}

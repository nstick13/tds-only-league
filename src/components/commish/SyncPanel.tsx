"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { timeAgo, timeUntil } from "@/lib/timeAgo";
import { triggerSyncAction } from "@/app/(app)/commish/actions";
import type { ManualSyncCooldownMap, SyncStatusMap } from "@/lib/db/sync";
import type { SyncSource } from "@/lib/types";
import type { SyncSourceTrigger } from "@/app/(app)/commish/types";

interface SyncPanelProps {
  syncStatus: SyncStatusMap;
  cooldowns: ManualSyncCooldownMap;
}

const SOURCE_LABEL: Record<SyncSource, string> = {
  players: "Players",
  schedule: "Schedule",
  scores: "Scores",
  locks: "Locks",
};

/** What each button actually runs, so the panel says which job it fires. */
const SOURCE_DESCRIPTION: Record<SyncSourceTrigger, string> = {
  players: "sync-players — league-wide player pool + injury status",
  scores: "sync-scores — touchdown tallies for the current stage",
};

/**
 * Hand-triggerable jobs. Schedule and locks run on cron and are status-only
 * here — see SyncSourceTrigger in the route's types.ts.
 */
const TRIGGERABLE: SyncSourceTrigger[] = ["players", "scores"];

/**
 * Manual sync triggers + last-run status per source. Best effort — if the
 * Edge Functions aren't reachable, the trigger fails gracefully with a clear
 * message rather than throwing.
 *
 * Each job is limited to one manual run per hour, league-wide (see
 * claim_manual_sync in supabase/migrations/0008_per_source_sync_cooldown.sql).
 * Players and Scores hold independent windows, so a roster refresh never
 * blocks a score pull mid-game. The buttons disable themselves while a
 * window runs, but that's cosmetic — the database is what enforces it, so a
 * stale page or a second commissioner can't get around it.
 */
export function SyncPanel({ syncStatus, cooldowns }: SyncPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingSource, setPendingSource] = useState<SyncSourceTrigger | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  // Re-render on a timer so each countdown ticks down without a reload.
  const [now, setNow] = useState(() => Date.now());

  // Earliest moment any running window expires — when it passes, pull fresh
  // server state so that button comes back on its own.
  const nextUnlockMs = TRIGGERABLE.map((s) => cooldowns[s]?.availableAt)
    .filter((iso): iso is string => !!iso)
    .map((iso) => new Date(iso).getTime())
    .filter((ms) => ms > now)
    .sort((a, b) => a - b)[0];

  useEffect(() => {
    if (nextUnlockMs == null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= nextUnlockMs) router.refresh();
    }, 15_000);
    return () => clearInterval(id);
  }, [nextUnlockMs, router]);

  function handleTrigger(source: SyncSourceTrigger) {
    setMessage(null);
    setPendingSource(source);
    startTransition(async () => {
      const result = await triggerSyncAction(source);
      setMessage({ text: result.message, ok: result.success });
      setPendingSource(null);
      // Refresh either way: a success starts that job's cooldown, and a
      // failure may mean someone else's cooldown is now in effect.
      router.refresh();
    });
  }

  /** Cooldown for one job, or null when it's available. */
  function activeCooldown(source: SyncSourceTrigger) {
    const cd = cooldowns[source];
    if (!cd?.availableAt) return null;
    return new Date(cd.availableAt).getTime() > now ? cd : null;
  }

  const sources: SyncSource[] = ["players", "schedule", "scores", "locks"];

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Sync Data</h2>
      <p className="font-mono text-sm text-retro-offwhite/70">
        Manual re-triggers for the player and score sync jobs. These normally
        run on a schedule (see supabase/functions/README.md) — use this only to
        force a refresh. To protect the Tank01 API call budget, each job can be
        run once per hour for the whole league: once anyone runs Players,
        Players is unavailable to everyone until its hour is up. Scores keeps
        its own separate hour.
      </p>

      <div className="flex flex-col gap-1 font-mono text-sm text-retro-offwhite/80">
        {sources.map((source) => {
          const log = syncStatus[source];
          return (
            <div key={source} className="flex items-center gap-2">
              <span className="w-20">{SOURCE_LABEL[source]}:</span>
              {log ? (
                <span className={log.status === "error" ? "text-retro-red" : "text-retro-offwhite/80"}>
                  {log.status === "error" ? "FAILED" : "OK"} — {timeAgo(log.ran_at)}
                  {log.player_count != null ? ` (${log.player_count} players)` : ""}
                  {log.message ? ` — ${log.message}` : ""}
                </span>
              ) : (
                <span className="text-retro-offwhite/50">never run</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3">
        {TRIGGERABLE.map((source) => {
          const cooling = activeCooldown(source);
          return (
            <PixelButton
              key={source}
              variant="secondary"
              onClick={() => handleTrigger(source)}
              disabled={isPending || !!cooling}
              title={SOURCE_DESCRIPTION[source]}
            >
              {isPending && pendingSource === source
                ? "Syncing..."
                : cooling && cooling.availableAt
                  ? `${SOURCE_LABEL[source]} ${timeUntil(cooling.availableAt, new Date(now))}`
                  : `Sync ${SOURCE_LABEL[source]}`}
            </PixelButton>
          );
        })}
      </div>

      {TRIGGERABLE.map((source) => {
        const cooling = activeCooldown(source);
        if (!cooling?.availableAt) return null;
        return (
          <p key={source} className="font-mono text-sm text-retro-offwhite/70">
            {cooling.lastTriggeredBy ?? "Someone"} ran {SOURCE_LABEL[source]}
            {cooling.lastTriggeredAt
              ? ` ${timeAgo(cooling.lastTriggeredAt, new Date(now))}`
              : ""}{" "}
            — unlocks again {timeUntil(cooling.availableAt, new Date(now))}.
          </p>
        );
      })}

      {message ? (
        <p
          className={["font-mono text-sm", message.ok ? "text-retro-green" : "text-retro-red"].join(
            " ",
          )}
        >
          {message.text}
        </p>
      ) : null}
    </PixelPanel>
  );
}

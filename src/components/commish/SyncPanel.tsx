"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PixelPanel } from "@/components/ui/PixelPanel";
import { PixelButton } from "@/components/ui/PixelButton";
import { timeAgo, timeUntil } from "@/lib/timeAgo";
import { triggerSyncAction } from "@/app/(app)/commish/actions";
import type { ManualSyncCooldown, SyncStatusMap } from "@/lib/db/sync";
import type { SyncSource } from "@/lib/types";
import type { SyncSourceTrigger } from "@/app/(app)/commish/types";

interface SyncPanelProps {
  syncStatus: SyncStatusMap;
  cooldown: ManualSyncCooldown;
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
  schedule: "sync-schedule — kickoff times + bye weeks",
  scores: "sync-scores — touchdown tallies for the current stage",
  locks: "apply-locks — lock any stage past its first kickoff",
};

/** Every deployed Edge Function in supabase/functions/ is triggerable. */
const TRIGGERABLE: SyncSourceTrigger[] = ["players", "schedule", "scores", "locks"];

/**
 * Manual sync triggers + last-run status per source. Best effort — if the
 * Edge Functions aren't deployed yet, the trigger fails gracefully with a
 * clear message rather than throwing.
 *
 * Manual triggers are limited to one per hour for the WHOLE LEAGUE (see
 * claim_manual_sync in supabase/migrations/0007_manual_sync_cooldown.sql):
 * the buttons below disable themselves while the window is running, but
 * that's only cosmetic — the database is what enforces it, so a stale page
 * or a second commissioner can't get around it.
 */
export function SyncPanel({ syncStatus, cooldown }: SyncPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingSource, setPendingSource] = useState<SyncSourceTrigger | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  // Re-render on a timer so the countdown ticks down without a reload.
  const [now, setNow] = useState(() => Date.now());

  const availableAtMs = cooldown.availableAt ? new Date(cooldown.availableAt).getTime() : null;
  const coolingDown = availableAtMs != null && availableAtMs > now;

  useEffect(() => {
    if (availableAtMs == null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      // The window just expired — pull fresh server state so the buttons
      // come back (and pick up any sync that ran in the meantime).
      if (t >= availableAtMs) router.refresh();
    }, 15_000);
    return () => clearInterval(id);
  }, [availableAtMs, router]);

  function handleTrigger(source: SyncSourceTrigger) {
    setMessage(null);
    setPendingSource(source);
    startTransition(async () => {
      const result = await triggerSyncAction(source);
      setMessage({ text: result.message, ok: result.success });
      setPendingSource(null);
      // Refresh either way: a success starts the cooldown, and a failure
      // may mean someone else's cooldown is now in effect.
      router.refresh();
    });
  }

  const sources: SyncSource[] = ["players", "schedule", "scores", "locks"];

  return (
    <PixelPanel raised className="flex flex-col gap-4">
      <h2 className="font-pixel text-sm text-retro-yellow">Sync Data</h2>
      <p className="font-mono text-sm text-retro-offwhite/70">
        Manual re-triggers for the sync jobs. These normally run on a schedule
        (see supabase/functions/README.md) — use this only to force a refresh.
        To protect the Tank01 API call budget, one manual sync per hour is
        allowed for the whole league: once anyone runs one, all of these are
        unavailable to everyone until the hour is up.
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
        {TRIGGERABLE.map((source) => (
          <PixelButton
            key={source}
            variant="secondary"
            onClick={() => handleTrigger(source)}
            disabled={isPending || coolingDown}
            title={SOURCE_DESCRIPTION[source]}
          >
            {isPending && pendingSource === source ? "Syncing..." : `Sync ${SOURCE_LABEL[source]}`}
          </PixelButton>
        ))}
      </div>

      {coolingDown && cooldown.availableAt ? (
        <p className="font-mono text-sm text-retro-offwhite/70">
          {cooldown.lastTriggeredBy ?? "Someone"} ran{" "}
          {cooldown.lastSource ? SOURCE_LABEL[cooldown.lastSource] : "a sync"}
          {cooldown.lastTriggeredAt ? ` ${timeAgo(cooldown.lastTriggeredAt, new Date(now))}` : ""} —
          manual syncs unlock again {timeUntil(cooldown.availableAt, new Date(now))}.
        </p>
      ) : null}

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

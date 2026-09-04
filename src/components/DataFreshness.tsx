import { getSyncFreshness } from "@/lib/db/sync";
import { timeAgoLong } from "@/lib/timeAgo";
import type { SyncSource } from "@/lib/types";

/**
 * Quiet data-freshness line. Server component: reads getSyncFreshness()
 * itself and renders above {children} in the authenticated app shell
 * (src/app/(app)/layout.tsx) on every page.
 *
 * REPLACES the old StalenessBanner, which shouted in red with animate-pulse
 * whenever a source crossed a staleness threshold. The alarm was the wrong
 * call: managers understand what a timestamp implies without being warned
 * about it, and a banner that flashes on every page becomes wallpaper. State
 * the facts and let people read them.
 *
 * Only the two sources managers actually reason about are listed — players
 * (which carries injury status) and scores. Schedule and lock jobs still run
 * and are still visible on the Commish page; they just aren't something a
 * manager needs on every screen.
 *
 * Freshness is the last SUCCESSFUL run, not the last attempt (see
 * getSyncFreshness) — a failed run must never read as "updated just now".
 */

const LINES: { source: SyncSource; label: string }[] = [
  { source: "players", label: "Players and Status" },
  { source: "scores", label: "Scores" },
];

export async function DataFreshness() {
  const freshness = await getSyncFreshness();

  return (
    <div className="border-b-2 border-retro-offwhite/15 bg-field-light/40">
      <div className="max-w-5xl mx-auto px-4 py-1.5 flex flex-wrap gap-x-6 gap-y-0.5 font-mono text-xs text-retro-offwhite/55">
        {LINES.map(({ source, label }) => {
          const f = freshness[source];
          return (
            <span key={source}>
              {label} Last Updated:{" "}
              <span className="text-retro-offwhite/75">
                {f?.lastSuccessAt ? timeAgoLong(f.lastSuccessAt) : "never"}
              </span>
              {f?.lastAttemptFailed ? (
                <span className="text-retro-offwhite/45"> (last sync attempt failed)</span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

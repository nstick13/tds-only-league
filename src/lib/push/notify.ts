import "server-only";
import { allManagerIds, sendToManagers } from "./send";

/**
 * The league's notification vocabulary. Two events, per the league's choice:
 * something needs you in the draft, and a week is in the books. No live
 * scoring alerts — TDs land through the normal sync and show up on the
 * league page.
 *
 * Every function here is fire-and-forget. Callers should NOT await these in a
 * way that can fail their action: a pick that saved must report success even
 * if Apple's push service is down. sendToManagers() already swallows its own
 * errors; these wrappers keep that contract.
 */

/** A stage's draft just opened — everyone drafts, so everyone hears about it. */
export async function notifyDraftOpen(stageName: string): Promise<void> {
  const managerIds = await allManagerIds();
  await sendToManagers(managerIds, {
    title: `${stageName} draft is open`,
    body: "Rosters are wiped — get in and draft.",
    url: "/draft",
    // One draft-open notification per stage; a re-send replaces it.
    tag: `draft-open-${stageName}`,
  });
}

/** One manager is on the clock. Sent to that manager only. */
export async function notifyOnTheClock(
  managerId: string,
  stageName: string,
  pickNumber: number,
): Promise<void> {
  await sendToManagers([managerId], {
    title: "You're on the clock",
    body: `${stageName} — pick #${pickNumber} is yours.`,
    url: "/draft",
    // Replaces any earlier on-the-clock alert rather than stacking a column
    // of them down the lock screen over a 56-pick draft.
    tag: "on-the-clock",
  });
}

/** A week has been finalized — league-wide, with the winner in the body. */
export async function notifyWeekFinal(
  stageName: string,
  winnerName: string | null,
  winnerPoints: number | null,
): Promise<void> {
  const managerIds = await allManagerIds();
  const body = winnerName
    ? `${winnerName} takes it with ${winnerPoints?.toFixed(1)} pts.`
    : "Final standings are up.";

  await sendToManagers(managerIds, {
    title: `${stageName} is final`,
    body,
    url: "/",
    tag: `final-${stageName}`,
  });
}

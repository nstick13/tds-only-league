/**
 * Formats a past ISO timestamp as a short relative "Xm ago" / "Xh ago"
 * string, for the sync-status / staleness UI. No external dependency —
 * intentionally coarse (minutes/hours/days), this is not a full i18n
 * relative-time formatter.
 */
export function timeAgo(isoTimestamp: string, now: Date = new Date()): string {
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now.getTime() - then;

  if (diffMs < 0) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Minutes elapsed since an ISO timestamp — used to compare against staleness thresholds. */
export function minutesAgo(isoTimestamp: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(isoTimestamp).getTime()) / 60_000);
}

/**
 * Formats a FUTURE ISO timestamp as "in Xm" / "in Xh Xm" — the mirror of
 * timeAgo(), used for the manual-sync cooldown ("unlocks again in 42m").
 * Returns "now" once the timestamp is in the past, so a stale render reads
 * as available rather than as a negative countdown.
 */
export function timeUntil(isoTimestamp: string, now: Date = new Date()): string {
  const diffMs = new Date(isoTimestamp).getTime() - now.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";

  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `in ${hours}h` : `in ${hours}h ${remainder}m`;
}

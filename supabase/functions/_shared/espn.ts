// ESPN "site.api" fetch helpers: retry with backoff, timeouts, small-batch
// concurrency, and an in-run cache. ESPN's site API is unofficial and
// undocumented — treat it as best-effort. NEVER fall back to stale/fake
// data on failure; callers are expected to log a sync_log error and abort
// instead (see each function's index.ts).

const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3; // total attempts, not extra retries
const RETRY_BASE_DELAY_MS = 500;

// ESPN's undocumented site API 403s server-side callers that don't look
// like a browser (no User-Agent, datacenter IP). Deno's default fetch sends
// no UA, so from Supabase Edge Functions every request was coming back 403.
// Send a browser-like UA + Accept so ESPN serves us normally.
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch JSON with a timeout and 2-3x retry w/ exponential backoff.
 * Throws on final failure — callers must treat that as fatal for the run
 * (log a sync_log error row, do not substitute stale data).
 */
export async function fetchJson<T = unknown>(
  url: string,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: DEFAULT_HEADERS,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`ESPN fetch ${url} -> HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }
  throw new Error(
    `ESPN fetch failed after ${retries} attempts for ${url}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** Run `fn` over `items` with limited concurrency, pausing briefly between batches so we never hammer ESPN. */
export async function mapWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I) => Promise<O>,
  delayBetweenBatchesMs = 250,
): Promise<{ results: O[]; errors: { item: I; error: unknown }[] }> {
  const results: O[] = [];
  const errors: { item: I; error: unknown }[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    settled.forEach((s, idx) => {
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        errors.push({ item: batch[idx], error: s.reason });
      }
    });
    if (i + concurrency < items.length) {
      await sleep(delayBetweenBatchesMs);
    }
  }

  return { results, errors };
}

// ---------------------------------------------------------------------------
// Typed-ish endpoint wrappers. ESPN's site API is undocumented so these
// types are intentionally loose (only the fields we actually read).
// ---------------------------------------------------------------------------

export interface EspnTeamIndexEntry {
  team: {
    id: string;
    abbreviation: string;
    displayName: string;
  };
}

export async function getTeamIndex(): Promise<EspnTeamIndexEntry[]> {
  const data = await fetchJson<{
    sports: { leagues: { teams: EspnTeamIndexEntry[] }[] }[];
  }>(`${BASE}/teams?limit=32`);
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams;
  if (!teams || teams.length === 0) {
    throw new Error("ESPN team index returned no teams");
  }
  return teams;
}

export interface EspnAthlete {
  id: string;
  fullName?: string;
  displayName?: string;
  position?: { abbreviation?: string };
  injuries?: { status?: string; details?: { detail?: string } }[];
}

export interface EspnRosterCategory {
  position?: string;
  items?: EspnAthlete[];
}

export async function getTeamRoster(
  teamId: string,
): Promise<EspnRosterCategory[]> {
  const data = await fetchJson<{ athletes?: EspnRosterCategory[] }>(
    `${BASE}/teams/${teamId}/roster`,
  );
  if (!data?.athletes) {
    throw new Error(`ESPN roster for team ${teamId} missing athletes[]`);
  }
  return data.athletes;
}

export interface EspnEvent {
  id: string;
  date: string;
  competitions: {
    competitors: { team: { id: string } }[];
  }[];
}

export interface EspnScoreboard {
  events: EspnEvent[];
}

export async function getScoreboard(
  seasonType: number,
  week: number,
): Promise<EspnScoreboard> {
  const data = await fetchJson<EspnScoreboard>(
    `${BASE}/scoreboard?week=${week}&seasontype=${seasonType}`,
  );
  if (!data?.events) {
    throw new Error(
      `ESPN scoreboard (week=${week}, seasontype=${seasonType}) missing events[]`,
    );
  }
  return data;
}

export interface EspnBoxscoreAthleteStat {
  athlete: { id: string; displayName?: string };
  stats: string[];
}

export interface EspnBoxscoreStatCategory {
  name: string; // "passing" | "rushing" | "receiving" | ...
  labels: string[];
  athletes: EspnBoxscoreAthleteStat[];
}

export interface EspnBoxscoreTeamPlayers {
  team: { id: string };
  statistics: EspnBoxscoreStatCategory[];
}

export interface EspnGameSummary {
  boxscore?: { players?: EspnBoxscoreTeamPlayers[] };
  // scoringPlays is present on most summaries but its per-play athlete
  // attribution is less structured than the boxscore stat categories — see
  // README "scoringPlays parsing assumptions" for why we prefer boxscore.
  scoringPlays?: unknown[];
}

export async function getGameSummary(
  eventId: string,
): Promise<EspnGameSummary> {
  return await fetchJson<EspnGameSummary>(
    `${BASE}/summary?event=${eventId}`,
  );
}

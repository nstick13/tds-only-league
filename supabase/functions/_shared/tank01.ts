// Tank01 NFL (RapidAPI) fetch helpers: retry with backoff, timeouts, limited
// concurrency, and typed endpoint wrappers.
//
// Unlike the ESPN site API this replaces, Tank01 is a real paid product with
// documented endpoints and an auth header — so there is no header-guessing
// here. What there IS is a hard quota (Pro plan: 1,000 calls/day), which is
// why callers batch, page, and skip finalized games rather than re-polling.
// See supabase/migrations/0004_cron.sql for the call budget these cadences
// are sized against.
//
// NEVER fall back to stale/fake data on failure; callers log a sync_log error
// row and abort (see each function's index.ts).
//
// Response shapes below were derived from real captured responses committed
// in reference/tank01/*.sample.json — not from documentation and not guessed.
// If you change a field name here, check it against those samples first.

const HOST = "tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com";
const BASE = `https://${HOST}`;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3; // total attempts, not extra retries
const RETRY_BASE_DELAY_MS = 500;

/** Page size Tank01 returns for getNFLPlayerList. Used only as a sanity guard. */
const PLAYER_PAGE_GUARD = 20;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiKey(): string {
  const key = Deno.env.get("RAPIDAPI_KEY");
  if (!key) {
    throw new Error(
      "RAPIDAPI_KEY is not set. Set it with: supabase secrets set RAPIDAPI_KEY=<key>",
    );
  }
  return key;
}

/** Tank01 wraps every payload as { statusCode, body }. */
interface Tank01Envelope<T> {
  statusCode?: number;
  body?: T;
  error?: string;
}

/**
 * Fetch one Tank01 endpoint and unwrap `body`.
 *
 * Throws on final failure — fatal for the run. A 429 (quota/rate limit) is
 * retried with a longer backoff than other errors, because on a quota'd plan
 * hammering it makes the situation worse, not better.
 */
export async function fetchTank01<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const href = url.toString();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(href, {
        signal: controller.signal,
        headers: {
          "X-RapidAPI-Key": apiKey(),
          "X-RapidAPI-Host": HOST,
        },
      });
      clearTimeout(timer);

      if (!res.ok) {
        const snippet = await res.text().then((t) => t.slice(0, 300)).catch(
          () => "<unreadable body>",
        );
        const err = new Error(
          `Tank01 ${path} -> HTTP ${res.status}: ${snippet}`,
        );
        // Quota / rate limit: back off much harder before trying again.
        if (res.status === 429 && attempt < retries) {
          lastErr = err;
          await sleep(RETRY_BASE_DELAY_MS * 8 * attempt);
          continue;
        }
        // 4xx other than 429 won't fix itself on retry — fail fast so the
        // sync_log row names the real problem (bad key, bad param) instead
        // of burning three calls of quota on it.
        if (res.status >= 400 && res.status < 500) throw err;
        throw err;
      }

      const json = (await res.json()) as Tank01Envelope<T>;
      if (json.body === undefined) {
        throw new Error(
          `Tank01 ${path} returned no body (statusCode=${json.statusCode}` +
            `${json.error ? `, error=${json.error}` : ""})`,
        );
      }
      return json.body;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Don't retry a definite client error.
      if (err instanceof Error && /HTTP 4(?!29)\d\d/.test(err.message)) break;
      if (attempt < retries) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(
    `Tank01 fetch failed for ${path}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** Run `fn` over `items` with limited concurrency, pausing between batches. */
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
      if (s.status === "fulfilled") results.push(s.value);
      else errors.push({ item: batch[idx], error: s.reason });
    });
    if (i + concurrency < items.length) await sleep(delayBetweenBatchesMs);
  }
  return { results, errors };
}

// ---------------------------------------------------------------------------
// Every numeric value Tank01 returns is a STRING ("3", "0", "", sometimes the
// key is absent entirely). Parse defensively — a missing stat category means
// the player didn't record that kind of stat, which is a zero, not an error.
// ---------------------------------------------------------------------------

export function toInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v !== "string") return 0;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// getNFLPlayerList — whole-league player pool, paginated.
// ---------------------------------------------------------------------------

export interface Tank01Injury {
  designation?: string; // "" | "Questionable" | "Out" | "Injured Reserve"
  description?: string;
  injDate?: string;
  injReturnDate?: string;
}

export interface Tank01Player {
  playerID: string; // === espnID (verified across a full 1000-row page)
  espnID?: string;
  longName?: string;
  firstName?: string;
  lastName?: string;
  pos?: string;
  team?: string; // abbreviation, e.g. "SEA"
  teamID?: string; // "1".."32"
  jerseyNum?: string;
  isFreeAgent?: string; // STRING "True" / "False"
  injury?: Tank01Injury;
}

interface PlayerListBody {
  players?: Tank01Player[];
  nextToken?: string;
}

/**
 * Fetch the entire league player pool, following `nextToken` pagination.
 *
 * This is the single biggest quota win over the ESPN layer: one paginated
 * call chain (~3 pages of 1000) instead of 1 team-index call + 32 roster
 * calls per run.
 */
export async function getPlayerList(
  opts: { maxPages?: number } = {},
): Promise<Tank01Player[]> {
  const maxPages = opts.maxPages ?? PLAYER_PAGE_GUARD;
  const all: Tank01Player[] = [];
  let token: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body = await fetchTank01<PlayerListBody>("getNFLPlayerList", {
      nextToken: token,
    });
    const batch = body?.players ?? [];
    if (batch.length === 0 && page === 0) {
      throw new Error("getNFLPlayerList returned zero players on the first page");
    }
    all.push(...batch);
    token = body?.nextToken;
    if (!token) return all;
  }
  // Ran out of page budget with a cursor still outstanding: return what we
  // have but say so loudly, rather than silently syncing a partial league.
  throw new Error(
    `getNFLPlayerList did not terminate within ${maxPages} pages ` +
      `(collected ${all.length} players); refusing to sync a partial pool`,
  );
}

// ---------------------------------------------------------------------------
// getNFLTeams — team index AND the bye weeks (keyed by season year).
// ---------------------------------------------------------------------------

export interface Tank01Team {
  teamID: string;
  teamAbv: string;
  teamCity?: string;
  teamName?: string;
  conferenceAbv?: string;
  division?: string;
  /** Keyed by season year, e.g. { "2025": "10" }. Values can be comma-joined. */
  byeWeeks?: Record<string, string | string[]>;
}

export async function getTeams(): Promise<Tank01Team[]> {
  const body = await fetchTank01<Tank01Team[]>("getNFLTeams", {
    // Keep the payload small — we only need identity + byeWeeks.
    rosters: "false",
    schedules: "false",
    topPerformers: "false",
    teamStats: "false",
  });
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error("getNFLTeams returned no teams");
  }
  return body;
}

/** Bye week numbers for a team in a given season, normalised to numbers. */
export function byeWeeksFor(team: Tank01Team, season: string | number): number[] {
  const raw = team.byeWeeks?.[String(season)];
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  return parts.map((p) => toInt(p)).filter((n) => n > 0);
}

// ---------------------------------------------------------------------------
// getNFLGamesForWeek — the week's games: kickoff times, ids, status.
// ---------------------------------------------------------------------------

export interface Tank01Game {
  gameID: string; // e.g. "20250904_DAL@PHI" — feeds getNFLBoxScore
  gameDate?: string; // "20250904"
  gameTime?: string; // "8:20p"
  gameTime_epoch?: string; // unix SECONDS as a string — authoritative kickoff
  season?: string;
  seasonType?: string; // "Regular Season"
  gameWeek?: string; // "Week 1"
  gameStatus?: string; // "Scheduled" | "In Progress" | "Completed" | ...
  gameStatusCode?: string; // "0" scheduled, "1" in progress, "2" final
  home?: string;
  away?: string;
  teamIDHome?: string;
  teamIDAway?: string;
  neutralSite?: string;
}

export async function getGamesForWeek(
  week: string | number,
  seasonType: string,
  season: string | number,
): Promise<Tank01Game[]> {
  const body = await fetchTank01<Tank01Game[]>("getNFLGamesForWeek", {
    week,
    seasonType,
    season,
  });
  if (!Array.isArray(body)) {
    throw new Error(
      `getNFLGamesForWeek(week=${week}, seasonType=${seasonType}, season=${season}) ` +
        `did not return an array`,
    );
  }
  return body;
}

/** Kickoff as a JS Date, or null when Tank01 hasn't scheduled it yet. */
export function kickoffAt(game: Tank01Game): Date | null {
  const epoch = Number.parseFloat(game.gameTime_epoch ?? "");
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000);
}

/**
 * True once a game is final and its box score will never change again.
 *
 * This is what lets sync-scores stop re-fetching Sunday's 1pm games all
 * through Sunday night. gameStatusCode "2" is the documented final state;
 * the gameStatus string is checked too so a code change doesn't silently
 * make us re-poll everything forever.
 */
export function isFinal(game: Pick<Tank01Game, "gameStatus" | "gameStatusCode">): boolean {
  return game.gameStatusCode === "2" ||
    (game.gameStatus ?? "").toLowerCase() === "completed";
}

/** True when a game hasn't kicked off, so there are no stats to fetch yet. */
export function isScheduled(
  game: Pick<Tank01Game, "gameStatus" | "gameStatusCode">,
): boolean {
  return game.gameStatusCode === "0" ||
    (game.gameStatus ?? "").toLowerCase() === "scheduled";
}

// ---------------------------------------------------------------------------
// getNFLBoxScore — per-player TD counts for one game.
// ---------------------------------------------------------------------------

export interface Tank01PlayerGameStats {
  playerID?: string;
  longName?: string;
  teamID?: string;
  teamAbv?: string;
  Passing?: Record<string, string>;
  Rushing?: Record<string, string>;
  Receiving?: Record<string, string>;
  Defense?: Record<string, string>;
  Kicking?: Record<string, string>;
  Punting?: Record<string, string>;
}

export interface Tank01BoxScore {
  gameID?: string;
  gameStatus?: string;
  gameStatusCode?: string;
  seasonType?: string;
  gameWeek?: string;
  home?: string;
  away?: string;
  /** Keyed by playerID. */
  playerStats?: Record<string, Tank01PlayerGameStats>;
}

export async function getBoxScore(gameID: string): Promise<Tank01BoxScore> {
  const body = await fetchTank01<Tank01BoxScore>("getNFLBoxScore", { gameID });
  if (!body || typeof body !== "object") {
    throw new Error(`getNFLBoxScore(${gameID}) returned no object`);
  }
  return body;
}

/** Pass/rush/rec TD counts for one player in one game. */
export interface TdTally {
  pass_td: number;
  rush_td: number;
  rec_td: number;
}

/**
 * Extract this league's three scored TD types from one player's game stats.
 *
 * Deliberately ignores Defense.defTD, Kicking.kickReturnTD and
 * Punting.puntReturnTD. The league scores passing, rushing and receiving
 * touchdowns only (src/lib/scoring.ts, and the generated `points` column on
 * player_stage_stats) — and rosters are QB/RB/WR/TE, so defensive scores
 * can't belong to a rostered player anyway. Return TDs by a rostered skill
 * player ARE possible and ARE currently unscored; that's a rules question,
 * not a parsing bug. Don't "fix" it here without changing scoring.ts and the
 * DB generated column in the same commit.
 */
export function tdsFor(stats: Tank01PlayerGameStats): TdTally {
  return {
    pass_td: toInt(stats.Passing?.passTD),
    rush_td: toInt(stats.Rushing?.rushTD),
    rec_td: toInt(stats.Receiving?.recTD),
  };
}

export function hasAnyTd(t: TdTally): boolean {
  return t.pass_td > 0 || t.rush_td > 0 || t.rec_td > 0;
}

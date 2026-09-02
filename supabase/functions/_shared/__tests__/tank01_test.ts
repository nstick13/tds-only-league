// Parser tests run against the REAL captured Tank01 responses in
// reference/tank01/*.sample.json — not hand-written fixtures. The whole
// reason we migrated off ESPN was that its box-score shape was never
// validated against a live response, so these assertions exist to make sure
// we don't repeat that with Tank01.
//
// Run: deno test --allow-read supabase/functions/_shared/__tests__/

// Local assert helpers: no third-party import, so these tests run anywhere
// Deno does (CI, a sandbox, a laptop offline) without a network fetch.
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? msg + ": " : ""}expected ${b}, got ${a}`);
}
import {
  byeWeeksFor,
  hasAnyTd,
  isFinal,
  isScheduled,
  kickoffAt,
  type Tank01BoxScore,
  type Tank01Game,
  type Tank01Player,
  type Tank01Team,
  tdsFor,
  toInt,
} from "../tank01.ts";

const ROOT = new URL("../../../../reference/tank01/", import.meta.url);
const load = async <T>(f: string): Promise<T> =>
  JSON.parse(await Deno.readTextFile(new URL(f, ROOT)));

Deno.test("toInt handles Tank01's string numbers, blanks and missing keys", () => {
  assertEquals(toInt("3"), 3);
  assertEquals(toInt("0"), 0);
  assertEquals(toInt(""), 0);
  assertEquals(toInt(undefined), 0);
  assertEquals(toInt("-2"), -2); // negative rushing yards are real
  assertEquals(toInt("4.9"), 4); // truncates, never NaN
  assertEquals(toInt("n/a"), 0);
});

Deno.test("tdsFor pulls the three scored TD types off a real box score", async () => {
  const box = await load<{ body: Tank01BoxScore }>("getNFLBoxScore.sample.json");
  const ps = box.body.playerStats!;

  // Mariota: 2 passing TDs, 0 rushing.
  assertEquals(tdsFor(ps["2576980"]), { pass_td: 2, rush_td: 0, rec_td: 0 });
  // Brian Robinson Jr.: 1 rushing TD.
  assertEquals(tdsFor(ps["4241474"]), { pass_td: 0, rush_td: 1, rec_td: 0 });
  // Zach Ertz: 1 receiving TD.
  assertEquals(tdsFor(ps["15835"]), { pass_td: 0, rush_td: 0, rec_td: 1 });
});

Deno.test("tdsFor ignores defensive and return TDs (league scores pass/rush/rec only)", async () => {
  const box = await load<{ body: Tank01BoxScore }>("getNFLBoxScore.sample.json");
  const ps = box.body.playerStats!;

  // Dante Fowler Jr. returned an interception for a TD (Defense.defTD = "1").
  // He is a defender, unrosterable here, and must contribute nothing.
  const fowler = ps["2980100"];
  assertEquals(fowler.Defense?.defTD, "1", "sample should still contain a defTD");
  assertEquals(tdsFor(fowler), { pass_td: 0, rush_td: 0, rec_td: 0 });
  assert(!hasAnyTd(tdsFor(fowler)));

  // Ekeler has a Kicking.kickReturnTD field; a return TD must not be scored.
  const ekeler = ps["3068267"];
  assert("kickReturnTD" in (ekeler.Kicking ?? {}));
  assertEquals(tdsFor(ekeler), { pass_td: 0, rush_td: 0, rec_td: 0 });
});

Deno.test("tdsFor is safe on a player with no stat categories at all", () => {
  assertEquals(tdsFor({}), { pass_td: 0, rush_td: 0, rec_td: 0 });
});

Deno.test("game status gating: final games stop being polled", async () => {
  const box = await load<{ body: Tank01BoxScore }>("getNFLBoxScore.sample.json");
  assert(isFinal(box.body), "completed game must read as final");
  assert(!isScheduled(box.body));

  const week = await load<{ body: Tank01Game[] }>("getNFLGamesForWeek.sample.json");
  const g = week.body[0];
  assert(isScheduled(g), "an unplayed game must read as scheduled");
  assert(!isFinal(g), "an unplayed game must not read as final");
});

Deno.test("kickoffAt converts gameTime_epoch to a real Date", async () => {
  const week = await load<{ body: Tank01Game[] }>("getNFLGamesForWeek.sample.json");
  const d = kickoffAt(week.body[0]);
  assert(d instanceof Date && !Number.isNaN(d.getTime()));
  // 1757031600 = 2025-09-05T00:20:00Z (Thu 8:20p ET) — note it lands on the
  // NEXT UTC day, which is exactly why 0004_cron.sql's windows are UTC-shifted.
  assertEquals(d!.toISOString(), "2025-09-05T00:20:00.000Z");
  assertEquals(kickoffAt({ gameID: "x" }), null);
  assertEquals(kickoffAt({ gameID: "x", gameTime_epoch: "" }), null);
});

Deno.test("byeWeeksFor reads byes off the team payload", async () => {
  const teams = await load<{ body: Tank01Team[] }>("getNFLTeams.sample.json");
  const t = teams.body[0];
  assert(t.byeWeeks, "sample team should carry byeWeeks");
  const byes = byeWeeksFor(t, "2025");
  assert(byes.every((n) => Number.isInteger(n) && n > 0 && n <= 18), `bad byes: ${byes}`);
  assertEquals(byeWeeksFor(t, "1999"), []); // unknown season -> no byes, not a crash
});

Deno.test("player list: playerID is the ESPN athlete id (no re-keying needed)", async () => {
  const pl = await load<{ body: { players: Tank01Player[] } }>(
    "getNFLPlayerList.sample.json",
  );
  const players = pl.body.players;
  assert(players.length > 0);
  for (const p of players) {
    assertEquals(
      p.playerID,
      p.espnID,
      `${p.longName}: playerID ${p.playerID} != espnID ${p.espnID}`,
    );
  }
  // isFreeAgent is a STRING, so truthiness checks on it are always true.
  const fa = players.find((p) => p.isFreeAgent === "True");
  assert(fa, "sample should include a free agent");
  assert(typeof fa!.isFreeAgent === "string");
});

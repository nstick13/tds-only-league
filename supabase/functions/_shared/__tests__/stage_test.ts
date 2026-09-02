// Tests for stage addressing helpers.
//
// currentSeason() is the kind of thing that looks obviously right and is
// wrong for two months a year, so the January cases are pinned here.

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ? msg + ": " : ""}expected ${expected}, got ${actual}`,
    );
  }
}

import {
  currentSeason,
  isAddressable,
  type StageRow,
  unaddressedStageMessage,
} from "../stage.ts";

const stage = (over: Partial<StageRow> = {}): StageRow => ({
  id: 1,
  name: "Week 1",
  ordinal: 1,
  season_type: "Regular Season",
  week_num: 1,
  status: "upcoming",
  first_kickoff_at: null,
  ...over,
});

Deno.test("currentSeason: a season is named for the year it starts in", () => {
  // September 2025 -> the 2025 season.
  assertEquals(currentSeason(new Date("2025-09-04T00:20:00Z")), 2025);
  // December 2025 -> still the 2025 season.
  assertEquals(currentSeason(new Date("2025-12-28T18:00:00Z")), 2025);
  // THE BUG THIS GUARDS: January playoffs belong to the PREVIOUS year's season.
  assertEquals(currentSeason(new Date("2026-01-11T18:00:00Z")), 2025);
  // Super Bowl in February, same story.
  assertEquals(currentSeason(new Date("2026-02-08T23:30:00Z")), 2025);
  // Dead offseason in June still resolves to the season just finished.
  assertEquals(currentSeason(new Date("2026-06-15T12:00:00Z")), 2025);
  // July flips over to the upcoming season.
  assertEquals(currentSeason(new Date("2026-07-01T12:00:00Z")), 2026);
});

Deno.test("isAddressable gates unconfigured postseason stages", () => {
  assert(isAddressable(stage()));
  assert(!isAddressable(stage({ season_type: null, week_num: null })));
  // Half-set rows are impossible in the DB (CHECK constraint in 0005) but the
  // guard must not treat them as usable if one ever slips through.
  assert(!isAddressable(stage({ season_type: null })));
  assert(!isAddressable(stage({ week_num: null })));
});

Deno.test("unaddressedStageMessage names the stage and the fix", () => {
  const msg = unaddressedStageMessage(
    stage({
      name: "Wild Card",
      ordinal: 19,
      season_type: null,
      week_num: null,
    }),
  );
  assert(msg.includes("Wild Card"));
  assert(msg.includes("19"));
  assert(msg.includes("0006_tank01_stage_addressing.sql"));
});

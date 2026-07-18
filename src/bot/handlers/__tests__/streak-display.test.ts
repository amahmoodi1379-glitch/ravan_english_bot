import { describe, it, expect } from "vitest";
import { resolveStreakDisplay } from "../profile";
import { iranDateStr, shiftDateStr } from "../../../utils/iran_time";

/**
 * resolveStreakDisplay replaced a two-query getStreakInfo (one read for the streak
 * fields, one pure DB round-trip just to compute today/yesterday). These assertions
 * pin the exact rule the old SQL implemented: a streak shows only if the last
 * streak day is today or yesterday in Iran-local time; otherwise it has lapsed.
 */
describe("resolveStreakDisplay", () => {
  // A fixed instant so today/yesterday are deterministic.
  const nowMs = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18 12:00 UTC
  const today = iranDateStr(nowMs);
  const yesterday = shiftDateStr(today, -1);
  const twoDaysAgo = shiftDateStr(today, -2);

  it("returns 0 when the streak count is 0, regardless of date", () => {
    expect(resolveStreakDisplay(0, today, nowMs)).toBe(0);
  });

  it("returns 0 for null/undefined count", () => {
    expect(resolveStreakDisplay(null, today, nowMs)).toBe(0);
    expect(resolveStreakDisplay(undefined, today, nowMs)).toBe(0);
  });

  it("shows the streak when the last streak day is today", () => {
    expect(resolveStreakDisplay(7, today, nowMs)).toBe(7);
  });

  it("shows the streak when the last streak day is yesterday (still alive)", () => {
    expect(resolveStreakDisplay(3, yesterday, nowMs)).toBe(3);
  });

  it("treats a streak as lapsed (0) when the last day is two days ago", () => {
    expect(resolveStreakDisplay(9, twoDaysAgo, nowMs)).toBe(0);
  });

  it("treats a missing last_streak_date as lapsed when count > 0", () => {
    expect(resolveStreakDisplay(5, null, nowMs)).toBe(0);
    expect(resolveStreakDisplay(5, "", nowMs)).toBe(0);
  });

  it("matches the Iran-local boundary near midnight (uses +3.5h offset)", () => {
    // 2026-07-18 20:45 UTC = 2026-07-19 00:15 Iran → 'today' is the 19th.
    const lateMs = Date.UTC(2026, 6, 18, 20, 45, 0);
    expect(iranDateStr(lateMs)).toBe("2026-07-19");
    expect(resolveStreakDisplay(4, "2026-07-19", lateMs)).toBe(4); // today (Iran)
    expect(resolveStreakDisplay(4, "2026-07-18", lateMs)).toBe(4); // yesterday (Iran)
    expect(resolveStreakDisplay(4, "2026-07-17", lateMs)).toBe(0); // lapsed
  });
});

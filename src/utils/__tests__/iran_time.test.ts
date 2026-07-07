import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  iranDateStr,
  iranWeekStartDate,
  iranMonthStartDate,
  iranMidnightToUtc,
  iranWallClockToUtcStamp,
  shiftDateStr,
  iranNow,
  parseUtcStamp,
} from "../iran_time";
import { toJalaliParts } from "../jalali";

/** ms for an Iran-local wall-clock instant: local midnight of `ymd` plus hours. */
function iranInstantMs(ymd: string, hours: number): number {
  return parseUtcStamp(iranMidnightToUtc(ymd)).getTime() + hours * 60 * 60 * 1000;
}

describe("iranMidnightToUtc", () => {
  it("maps Iran 00:00 to previous-day 20:30 UTC (+3.5h offset)", () => {
    expect(iranMidnightToUtc("2026-07-04")).toBe("2026-07-03 20:30:00");
  });
});

describe("iranWallClockToUtcStamp (deterministic tournament window)", () => {
  it("pins 21:00 / 22:00 Iran to the correct UTC stamps", () => {
    expect(iranWallClockToUtcStamp("2026-07-04", 21)).toBe("2026-07-04 17:30:00");
    expect(iranWallClockToUtcStamp("2026-07-04", 22)).toBe("2026-07-04 18:30:00");
    // Round-trips back to the same instant regardless of host timezone.
    expect(parseUtcStamp(iranWallClockToUtcStamp("2026-07-04", 21)).getTime()).toBe(
      Date.UTC(2026, 6, 4, 17, 30, 0)
    );
  });
});

describe("shiftDateStr", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDateStr("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftDateStr("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDateStr("2026-07-04", 7)).toBe("2026-07-11");
  });
});

describe("iranWeekStartDate", () => {
  it("always returns an Iran-local Saturday, and the instant falls in [start, start+7)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 * 365 * 24 }), (hoursFromEpochBase) => {
        // Sample instants across ~4 years.
        const t = Date.UTC(2024, 0, 1) + hoursFromEpochBase * 60 * 60 * 1000;
        const weekStart = iranWeekStartDate(t);

        // The week-start's Iran-local midnight is a Saturday (getUTCDay === 6).
        const startMs = parseUtcStamp(iranMidnightToUtc(weekStart)).getTime();
        expect(iranNow(startMs).getUTCDay()).toBe(6);

        // The instant's Iran date is within [weekStart, weekStart + 7).
        const today = iranDateStr(t);
        expect(today >= weekStart).toBe(true);
        expect(today < shiftDateStr(weekStart, 7)).toBe(true);
      })
    );
  });
});

describe("iranMonthStartDate", () => {
  it("returns the 1st of the current Jalali month, and the instant falls within that month", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 * 365 * 24 }), (hoursFromEpochBase) => {
        const t = Date.UTC(2024, 0, 1) + hoursFromEpochBase * 60 * 60 * 1000;
        const monthStart = iranMonthStartDate(t);

        // The month-start's Iran-local Jalali day-of-month is exactly 1.
        const startMs = parseUtcStamp(iranMidnightToUtc(monthStart)).getTime();
        expect(toJalaliParts(iranNow(startMs))[2]).toBe(1);

        // The month-start and the instant share the same Jalali year+month.
        const [sy, sm] = toJalaliParts(iranNow(startMs));
        const [ty, tm] = toJalaliParts(iranNow(t));
        expect([sy, sm]).toEqual([ty, tm]);

        // The month-start is on or before the instant's Iran date.
        expect(monthStart <= iranDateStr(t)).toBe(true);
      })
    );
  });

  it("pins a known date to its Jalali month start", () => {
    // 2026-07-07 is 16 Tir 1405 (Iran) → month starts 1 Tir 1405 = 2026-06-22.
    const t = Date.UTC(2026, 6, 7, 12);
    expect(iranMonthStartDate(t)).toBe("2026-06-22");
  });
});

describe("weekly-league boundary (the Friday-night edge case)", () => {
  it("Friday 22:00 counts for the ending week; Saturday 00:30 starts the new week", () => {
    // Anchor on some real week's Saturday start.
    const anchor = iranWeekStartDate(Date.UTC(2026, 6, 6, 12)); // an Iran Saturday date
    expect(iranNow(parseUtcStamp(iranMidnightToUtc(anchor)).getTime()).getUTCDay()).toBe(6);

    const fridayNight = iranInstantMs(shiftDateStr(anchor, 6), 22); // Friday 22:00 Iran
    const saturdayEarly = iranInstantMs(shiftDateStr(anchor, 7), 0.5); // next Sat 00:30 Iran

    // Friday-night activity is attributed to the week that started on `anchor`.
    expect(iranWeekStartDate(fridayNight)).toBe(anchor);
    // The first minutes of Saturday belong to the NEXT week (7 days later).
    expect(iranWeekStartDate(saturdayEarly)).toBe(shiftDateStr(anchor, 7));
  });
});

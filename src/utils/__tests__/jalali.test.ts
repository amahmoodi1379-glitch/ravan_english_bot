import { describe, it, expect } from "vitest";
import { toJalaliParts, toJalaliString } from "../jalali";

describe("toJalaliParts", () => {
  it("maps Nowruz 2024-03-20 to 1 Farvardin 1403", () => {
    const [jy, jm, jd] = toJalaliParts(new Date(Date.UTC(2024, 2, 20)));
    expect(jy).toBe(1403);
    expect(jm).toBe(1);
    expect(jd).toBe(1);
  });

  it("treats the day before Nowruz as the last day of Esfand (month 12)", () => {
    // Used by the monthly-report gate: today is month-end iff tomorrow's jd === 1.
    const [, jm] = toJalaliParts(new Date(Date.UTC(2024, 2, 19)));
    expect(jm).toBe(12);
  });
});

describe("toJalaliString (Iran-local)", () => {
  it("formats a UTC timestamp using the Iran-local calendar date", () => {
    // 2024-03-19 22:00 UTC is already 2024-03-20 01:30 in Iran (UTC+3:30) — Nowruz.
    expect(toJalaliString("2024-03-19T22:00:00.000Z", "short")).toBe("۱۴۰۳/۰۱/۰۱");
  });

  it("rolls the displayed day forward once Iran crosses midnight (off-by-one guard)", () => {
    // 21:00 UTC on 2024-03-20 = 00:30 Iran on 2024-03-21 → 2 Farvardin, not 1.
    expect(toJalaliString("2024-03-20T21:00:00.000Z", "short")).toBe("۱۴۰۳/۰۱/۰۲");
  });

  it("accepts SQLite datetime('now') format (space separator, no Z)", () => {
    expect(toJalaliString("2024-03-19 22:00:00", "short")).toBe("۱۴۰۳/۰۱/۰۱");
  });

  it("returns '-' for an invalid date", () => {
    expect(toJalaliString("not-a-date")).toBe("-");
  });
});

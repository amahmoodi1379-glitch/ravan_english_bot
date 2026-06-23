import { describe, it, expect } from "vitest";
import { toJalaliParts } from "../jalali";

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

import { describe, it, expect } from "vitest";
import { LEAGUE_CONFIG } from "../../config/constants";
import { leagueTierBadgeCode } from "../../config/badges";
import { movementCounts, evenDivisionSizes } from "../leagues";

/**
 * Pure re-implementation of the per-user outcome decision in settleLeague, using
 * the REAL dynamic promote/demote counts, so the gentle-inactivity rule and
 * promote/demote/champion logic are unit-tested at any division size.
 */
function decideOutcome(weeklyXp: number, rank: number, n: number, tier: number, top: number) {
  const { promote, demote } = movementCounts(n);
  if (weeklyXp <= 0) {
    return tier > 1 ? { outcome: "demote", newTier: tier - 1 } : { outcome: "stay", newTier: 1 };
  }
  if (rank <= promote && tier < top) return { outcome: "promote", newTier: tier + 1 };
  if (rank <= promote && tier === top) return { outcome: "champion", newTier: tier };
  if (rank > n - demote && tier > 1) return { outcome: "demote", newTier: tier - 1 };
  return { outcome: "stay", newTier: tier };
}

const TOP = LEAGUE_CONFIG.TIERS.length; // 5

describe("league gentle-inactivity rule", () => {
  it("0-XP at a high tier drops exactly ONE tier (not to bronze, not removed)", () => {
    expect(decideOutcome(0, 3, 30, 5, TOP)).toEqual({ outcome: "demote", newTier: 4 });
    expect(decideOutcome(0, 3, 30, 3, TOP)).toEqual({ outcome: "demote", newTier: 2 });
  });

  it("0-XP at bronze just stays (bronze is the floor)", () => {
    expect(decideOutcome(0, 10, 30, 1, TOP)).toEqual({ outcome: "stay", newTier: 1 });
  });
});

describe("league promote/demote/champion", () => {
  it("top ranks with XP promote; bottom active demote; middle stays", () => {
    expect(decideOutcome(100, 1, 30, 2, TOP)).toEqual({ outcome: "promote", newTier: 3 });
    expect(decideOutcome(5, 30, 30, 2, TOP)).toEqual({ outcome: "demote", newTier: 1 });
    expect(decideOutcome(50, 15, 30, 2, TOP)).toEqual({ outcome: "stay", newTier: 2 });
  });

  it("top-tier winners become champions (no tier above)", () => {
    expect(decideOutcome(999, 1, 30, TOP, TOP)).toEqual({ outcome: "champion", newTier: TOP });
  });
});

describe("dynamic movement counts (movementCounts)", () => {
  it("scales ≈20% with division size and always leaves a stay zone (n>=3)", () => {
    expect(movementCounts(30)).toEqual({ promote: 6, demote: 6 });
    expect(movementCounts(20)).toEqual({ promote: 4, demote: 4 });
    expect(movementCounts(10)).toEqual({ promote: 2, demote: 2 });
    expect(movementCounts(5)).toEqual({ promote: 1, demote: 1 });
    // For every size >= 3 there is at least one "stay" slot (promote+demote < n).
    for (let n = 3; n <= 60; n++) {
      const { promote, demote } = movementCounts(n);
      expect(promote + demote).toBeLessThan(n);
    }
  });

  it("a tiny division (n<=2) moves nobody — no lone auto-promotion", () => {
    expect(movementCounts(1)).toEqual({ promote: 0, demote: 0 });
    expect(movementCounts(2)).toEqual({ promote: 0, demote: 0 });
    expect(decideOutcome(100, 1, 1, 2, TOP)).toEqual({ outcome: "stay", newTier: 2 });
  });

  it("small divisions no longer promote everyone (regression: fixed 7/7 bug)", () => {
    // 5-person division: only the top 1 promotes, the bottom 1 demotes, 3 stay.
    expect(decideOutcome(100, 1, 5, 2, TOP)).toEqual({ outcome: "promote", newTier: 3 });
    expect(decideOutcome(80, 2, 5, 2, TOP)).toEqual({ outcome: "stay", newTier: 2 });
    expect(decideOutcome(60, 4, 5, 2, TOP)).toEqual({ outcome: "stay", newTier: 2 });
    expect(decideOutcome(10, 5, 5, 2, TOP)).toEqual({ outcome: "demote", newTier: 1 });
  });
});

describe("even division balancing (evenDivisionSizes)", () => {
  it("uses the fewest divisions and spreads members evenly (differ by <=1)", () => {
    expect(evenDivisionSizes(63, 30)).toEqual([21, 21, 21]); // was 30/30/3
    expect(evenDivisionSizes(65, 30)).toEqual([22, 22, 21]);
    expect(evenDivisionSizes(31, 30)).toEqual([16, 15]);
    expect(evenDivisionSizes(30, 30)).toEqual([30]);
    expect(evenDivisionSizes(1, 30)).toEqual([1]);
    expect(evenDivisionSizes(0, 30)).toEqual([]);
  });

  it("never exceeds capacity and always sums back to the total", () => {
    for (const total of [1, 5, 29, 30, 31, 90, 200, 601]) {
      const sizes = evenDivisionSizes(total, 30);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
      for (const s of sizes) expect(s).toBeLessThanOrEqual(30);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });
});

describe("leagueTierBadgeCode", () => {
  it("maps tiers 2..5 to tier badges and bronze to none", () => {
    expect(leagueTierBadgeCode(1)).toBeNull();
    expect(leagueTierBadgeCode(2)).toBe("league_silver");
    expect(leagueTierBadgeCode(3)).toBe("league_gold");
    expect(leagueTierBadgeCode(4)).toBe("league_ruby");
    expect(leagueTierBadgeCode(5)).toBe("league_diamond");
  });
});

import { describe, it, expect } from "vitest";
import { LEAGUE_CONFIG } from "../../config/constants";
import { leagueTierBadgeCode } from "../../config/badges";

/**
 * Pure re-implementation of the per-user outcome decision in settleLeague, so the
 * gentle-inactivity rule and promote/demote/champion logic are unit-tested.
 */
function decideOutcome(weeklyXp: number, rank: number, n: number, tier: number, top: number) {
  const { PROMOTE_COUNT, DEMOTE_COUNT } = LEAGUE_CONFIG;
  if (weeklyXp <= 0) {
    return tier > 1 ? { outcome: "demote", newTier: tier - 1 } : { outcome: "stay", newTier: 1 };
  }
  if (rank <= PROMOTE_COUNT && tier < top) return { outcome: "promote", newTier: tier + 1 };
  if (rank <= PROMOTE_COUNT && tier === top) return { outcome: "champion", newTier: tier };
  if (rank > n - DEMOTE_COUNT && tier > 1) return { outcome: "demote", newTier: tier - 1 };
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

describe("leagueTierBadgeCode", () => {
  it("maps tiers 2..5 to tier badges and bronze to none", () => {
    expect(leagueTierBadgeCode(1)).toBeNull();
    expect(leagueTierBadgeCode(2)).toBe("league_silver");
    expect(leagueTierBadgeCode(3)).toBe("league_gold");
    expect(leagueTierBadgeCode(4)).toBe("league_ruby");
    expect(leagueTierBadgeCode(5)).toBe("league_diamond");
  });
});

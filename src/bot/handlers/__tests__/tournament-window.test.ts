import { describe, it, expect } from "vitest";
import { TOURNAMENT_CONFIG } from "../../../config/constants";

/**
 * Pure re-implementation of the join-window decision in showTournamentEntry, so
 * we can assert the "nobody is cut off mid-attempt" guarantee without a bot.
 * Returns what the handler would do for a user with NO existing attempt.
 */
type Decision = "not_started" | "can_start" | "join_closed" | "show_results";
function decide(nowMs: number, opensMs: number): Decision {
  const lastJoinMs = opensMs + TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES * 60 * 1000;
  const closesMs = opensMs + (TOURNAMENT_CONFIG.CLOSE_HOUR - TOURNAMENT_CONFIG.OPEN_HOUR) * 60 * 60 * 1000;
  if (nowMs < opensMs) return "not_started";
  if (nowMs >= closesMs) return "show_results";
  if (nowMs < lastJoinMs) return "can_start";
  return "join_closed";
}

describe("tournament join-window invariant", () => {
  it("a joiner at the last allowed moment still gets the full duration before close", () => {
    // INVARIANT the config must satisfy so no attempt is cut off mid-quiz.
    const windowSpanMin = (TOURNAMENT_CONFIG.CLOSE_HOUR - TOURNAMENT_CONFIG.OPEN_HOUR) * 60;
    expect(TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES + TOURNAMENT_CONFIG.DURATION_MINUTES).toBeLessThanOrEqual(
      windowSpanMin
    );
  });

  it("decides start/closed/results correctly around the window boundaries", () => {
    const opens = Date.UTC(2026, 6, 4, 17, 30); // 21:00 Iran as UTC
    const min = 60 * 1000;
    const lastJoin = opens + TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES * min;
    const closes = opens + (TOURNAMENT_CONFIG.CLOSE_HOUR - TOURNAMENT_CONFIG.OPEN_HOUR) * 60 * min;

    expect(decide(opens - min, opens)).toBe("not_started");
    expect(decide(opens, opens)).toBe("can_start");
    expect(decide(lastJoin - min, opens)).toBe("can_start"); // 21:44 → allowed
    expect(decide(lastJoin, opens)).toBe("join_closed"); // 21:45 → no new start
    expect(decide(lastJoin + min, opens)).toBe("join_closed"); // 21:46 → no new start
    expect(decide(closes, opens)).toBe("show_results");
    expect(decide(closes + min, opens)).toBe("show_results");
  });
});

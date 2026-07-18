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

/**
 * Pure re-implementation of attemptEndMs (custom_quiz_user.ts): an attempt's
 * effective deadline is start + duration, HARD-CAPPED at the tournament's close.
 * This cap is why settling at CLOSE_HOUR is always "after the last person's exam"
 * — no attempt, no matter how late it starts, can still be running past close.
 */
function cappedEndMs(startMs: number, opensMs: number): number {
  const closesMs = opensMs + (TOURNAMENT_CONFIG.CLOSE_HOUR - TOURNAMENT_CONFIG.OPEN_HOUR) * 60 * 60 * 1000;
  const raw = startMs + TOURNAMENT_CONFIG.DURATION_MINUTES * 60 * 1000;
  return Math.min(raw, closesMs);
}

describe("tournament close-cap invariant (results sent after the last finisher)", () => {
  const opens = Date.UTC(2026, 6, 4, 17, 30); // 21:00 Iran as UTC
  const min = 60 * 1000;
  const closes = opens + (TOURNAMENT_CONFIG.CLOSE_HOUR - TOURNAMENT_CONFIG.OPEN_HOUR) * 60 * min;

  it("no attempt can run past close, for any start in the window", () => {
    // Every minute from open to close: the effective end never exceeds close.
    for (let t = opens; t <= closes; t += min) {
      expect(cappedEndMs(t, opens)).toBeLessThanOrEqual(closes);
    }
  });

  it("even a hypothetical last-second joiner (21:59) is capped at close, not cut short by early settling", () => {
    const start2159 = opens + 59 * min; // 21:59 Iran
    // Their exam effectively ends exactly at close, so a CLOSE_HOUR settlement is
    // right after them — never before. (In practice the 21:45 join window blocks
    // this start entirely; the cap is the belt-and-suspenders guarantee.)
    expect(cappedEndMs(start2159, opens)).toBe(closes);
  });

  it("a normal late joiner at the join deadline finishes strictly before close", () => {
    const lastJoin = opens + TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES * min;
    // Full duration from the last allowed start still lands before close.
    expect(cappedEndMs(lastJoin, opens)).toBeLessThan(closes);
  });
});

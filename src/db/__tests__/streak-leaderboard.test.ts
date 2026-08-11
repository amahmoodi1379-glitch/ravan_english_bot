import { describe, it, expect } from "vitest";
import { Env } from "../../types";
import { getLeaderboardStreak, getUserRankStreak } from "../leaderboard";
import { TIME_ZONE_OFFSET } from "../../config/constants";

/**
 * Guards the fix for "I'm on day 3 of my streak but I'm not on the استریک فعال
 * board, and people on day 1 are".
 *
 * The live board used to list only users whose last streak day was exactly TODAY,
 * so anyone who hadn't done today's questions yet vanished from it — even though
 * their streak was still alive and their profile still showed it (profile.ts's
 * resolveStreakDisplay counts today OR yesterday as alive). Meanwhile someone who
 * had just started and studied today sat above them at 1 day. These assertions pin
 * the board to the same alive-window the profile uses.
 */

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function makeEnv(rows: unknown[] = []) {
  const calls: RecordedCall[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind(...params: unknown[]) {
            calls.push({ sql, params });
            return stmt;
          },
          all: async () => ({ results: rows }),
          first: async () => rows[0] ?? null,
          run: async () => ({ meta: { changes: 0 } }),
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, calls };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("live streak board window", () => {
  it("includes a streak whose last day was yesterday — it is not broken yet", async () => {
    const { env, calls } = makeEnv([]);
    await getLeaderboardStreak(env, "live", 50);

    const sql = flat(calls[0].sql);
    expect(sql).toContain("u.last_streak_date >= date('now', ?, '-1 day')");
    // The old today-only rule is what hid a live day-3 streak before today's study.
    expect(sql).not.toMatch(/last_streak_date = date\('now', \?\)/);
    expect(calls[0].params[0]).toBe(TIME_ZONE_OFFSET);
  });

  it("still ranks by streak length, longest first", async () => {
    const { env } = makeEnv([
      { user_id: 1, display_name: "A", avatar_code: null, score: 3 },
      { user_id: 2, display_name: "B", avatar_code: null, score: 1 },
    ]);
    const board = await getLeaderboardStreak(env, "live", 50);
    expect(board.map((e) => [e.rank, e.user_id, e.score])).toEqual([
      [1, 1, 3],
      [2, 2, 1],
    ]);
  });

  it("leaves the all-time record board on its own rule (no alive window)", async () => {
    const { env, calls } = makeEnv([]);
    await getLeaderboardStreak(env, "record", 50);
    expect(flat(calls[0].sql)).not.toContain("last_streak_date");
  });
});

describe("a viewer's own live streak rank", () => {
  it("uses the stored count while the streak is alive", async () => {
    const { env } = makeEnv([{ streak_count: 3, max_streak_record: 9, streak_alive: 1, cnt: 4 }]);
    expect(await getUserRankStreak(env, 1, "live")).toEqual({ rank: 5, score: 3 });
  });

  it("scores a lapsed streak 0 rather than its stale stored count", async () => {
    // streak_count is only rewritten on the next study day, so a user who stopped
    // days ago still carries their old number — it must not be shown as current.
    const { env } = makeEnv([{ streak_count: 3, max_streak_record: 9, streak_alive: 0, cnt: 4 }]);
    expect(await getUserRankStreak(env, 1, "live")).toEqual({ rank: 5, score: 0 });
  });

  it("measures the rank against the same alive window as the board", async () => {
    const { env, calls } = makeEnv([{ streak_count: 3, max_streak_record: 9, streak_alive: 1, cnt: 0 }]);
    await getUserRankStreak(env, 1, "live");
    for (const call of calls) {
      expect(flat(call.sql)).toContain("last_streak_date >= date('now', ?, '-1 day')");
      expect(call.params[0]).toBe(TIME_ZONE_OFFSET);
    }
  });

  it("reports the all-time record from max_streak_record", async () => {
    const { env } = makeEnv([{ streak_count: 0, max_streak_record: 9, streak_alive: 0, cnt: 2 }]);
    expect(await getUserRankStreak(env, 1, "record")).toEqual({ rank: 3, score: 9 });
  });
});

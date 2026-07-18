import { describe, it, expect, beforeEach } from "vitest";
import { Env } from "../../types";
import {
  getLeaderboardXp,
  getUserRankXp,
  _resetLeaderboardCaches,
} from "../leaderboard";

/**
 * The weekly/monthly XP leaderboard caches ONE full ranked snapshot per period and
 * serves both the top-N board and every user's rank from it. These tests pin two
 * things: (1) the derivations are correct — the board is the top slice and a user's
 * rank is (# strictly-higher scores) + 1, matching the old SQL exactly, including
 * ties; (2) the snapshot is fetched once per TTL, so the second read is a cache hit
 * (zero extra DB round-trips) until the cache is reset.
 */

type Row = { user_id: number; display_name: string; avatar_code: string | null; score: number };

function makeEnv(rows: Row[]) {
  let allCalls = 0;
  const env = {
    DB: {
      prepare(_sql: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              all: async () => {
                allCalls++;
                return { results: rows };
              },
              first: async () => rows[0] ?? null,
              run: async () => ({ meta: { changes: 0 } }),
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, getAllCalls: () => allCalls };
}

// Deterministic instant so the period key is stable across calls.
const NOW = Date.UTC(2026, 6, 15, 9, 0, 0);

const STANDINGS: Row[] = [
  { user_id: 1, display_name: "A", avatar_code: null, score: 100 },
  { user_id: 2, display_name: "B", avatar_code: null, score: 50 },
  { user_id: 3, display_name: "C", avatar_code: null, score: 50 },
  { user_id: 4, display_name: "D", avatar_code: null, score: 10 },
];

describe("XP leaderboard snapshot cache", () => {
  beforeEach(() => {
    _resetLeaderboardCaches();
  });

  it("builds the board as the top slice with sequential ranks", async () => {
    const { env } = makeEnv(STANDINGS);
    const board = await getLeaderboardXp(env, "weekly", 3, NOW);
    expect(board.map((e) => [e.rank, e.user_id, e.score])).toEqual([
      [1, 1, 100],
      [2, 2, 50],
      [3, 3, 50],
    ]);
  });

  it("derives a user's rank as (# strictly-higher scores) + 1, ties sharing a rank", async () => {
    const { env } = makeEnv(STANDINGS);
    // user 3 ties user 2 at 50 → both rank 2 (only user 1 is strictly higher).
    expect(await getUserRankXp(env, 3, "weekly", NOW)).toEqual({ rank: 2, score: 50 });
    expect(await getUserRankXp(env, 2, "weekly", NOW)).toEqual({ rank: 2, score: 50 });
    expect(await getUserRankXp(env, 4, "weekly", NOW)).toEqual({ rank: 4, score: 10 });
  });

  it("returns score 0 and last-rank for a user absent from the standings", async () => {
    const { env } = makeEnv(STANDINGS);
    // Not in the snapshot → score 0, ranked behind everyone with score > 0.
    expect(await getUserRankXp(env, 999, "weekly", NOW)).toEqual({ rank: 5, score: 0 });
  });

  it("fetches the snapshot once per TTL — board + rank share it (one DB round-trip)", async () => {
    const { env, getAllCalls } = makeEnv(STANDINGS);
    await getLeaderboardXp(env, "weekly", 50, NOW);
    await getUserRankXp(env, 3, "weekly", NOW);
    await getUserRankXp(env, 4, "weekly", NOW);
    expect(getAllCalls()).toBe(1);
  });

  it("keeps weekly and monthly as separate cache entries", async () => {
    const { env, getAllCalls } = makeEnv(STANDINGS);
    await getLeaderboardXp(env, "weekly", 50, NOW);
    await getLeaderboardXp(env, "monthly", 50, NOW);
    expect(getAllCalls()).toBe(2);
  });

  it("refetches after the cache is reset", async () => {
    const { env, getAllCalls } = makeEnv(STANDINGS);
    await getLeaderboardXp(env, "weekly", 50, NOW);
    expect(getAllCalls()).toBe(1);
    _resetLeaderboardCaches();
    await getLeaderboardXp(env, "weekly", 50, NOW);
    expect(getAllCalls()).toBe(2);
  });
});

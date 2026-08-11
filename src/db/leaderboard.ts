import { Env } from "../types";
import { queryAll, queryOne } from "./client";
import { TIME_ZONE_OFFSET, LEADERBOARD_CACHE_TTL_MS } from "../config/constants";
import {
  iranWeekStartDate,
  iranMonthStartDate,
  iranMidnightToUtc,
} from "../utils/iran_time";

export type LeaderboardPeriod = "weekly" | "monthly" | "all";
export type StreakType = "live" | "record";

/**
 * In-isolate cache of the FULL ranked XP standings for a windowed period (weekly /
 * monthly). One such snapshot serves both the top-50 board AND any user's rank,
 * so a leaderboard tap costs at most one aggregation every LEADERBOARD_CACHE_TTL_MS
 * instead of the three full `activity_log` GROUP-BY/SUM scans it used to. Keyed by
 * `period:periodStartUtc` so a week/month rollover invalidates instantly (the start
 * boundary changes) rather than waiting out the TTL. Same best-effort, TTL-only
 * pattern as the channel-membership / emoji caches — never a source of truth.
 */
interface XpStanding {
  user_id: number;
  display_name: string;
  avatar_code: string | null;
  score: number;
}
const xpStandingsCache = new Map<string, { at: number; standings: XpStanding[] }>();

/** Clear the in-isolate leaderboard caches. Test-only seam. */
export function _resetLeaderboardCaches(): void {
  xpStandingsCache.clear();
}

/**
 * The full ranked XP standings (all eligible users with score > 0) for a windowed
 * period, cached in-isolate for LEADERBOARD_CACHE_TTL_MS. Sorted score DESC, then
 * user_id ASC — the exact order the board and rank derivations rely on.
 */
async function getXpStandingsCached(
  env: Env,
  period: "weekly" | "monthly",
  nowMs: number
): Promise<XpStanding[]> {
  const startUtc = periodStartUtc(period, nowMs);
  const key = `${period}:${startUtc}`;
  const cached = xpStandingsCache.get(key);
  if (cached && nowMs - cached.at < LEADERBOARD_CACHE_TTL_MS) return cached.standings;

  const rows = await queryAll<{
    user_id: number;
    display_name: string;
    avatar_code: string | null;
    score: number;
  }>(
    env,
    `
    SELECT al.user_id,
           COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
           u.avatar_code,
           SUM(al.xp_delta) as score
    FROM activity_log al
    JOIN users u ON u.id = al.user_id
    WHERE al.created_at >= ?
      AND u.is_approved = 1
      AND (u.is_banned IS NULL OR u.is_banned = 0)
    GROUP BY al.user_id
    HAVING score > 0
    ORDER BY score DESC, al.user_id ASC
    `,
    [startUtc]
  );

  const standings: XpStanding[] = rows.map((r) => ({
    user_id: r.user_id as number,
    display_name: r.display_name as string,
    avatar_code: (r.avatar_code as string | null) || null,
    score: (r.score as number) || 0,
  }));
  xpStandingsCache.set(key, { at: nowMs, standings });
  return standings;
}

/**
 * UTC lower-bound ('YYYY-MM-DD HH:MM:SS') for a windowed leaderboard period,
 * aligned to the SAME fixed Iran-calendar boundaries the league uses: the current
 * Persian week (Saturday 00:00 Iran) for "weekly" and the 1st of the current
 * Jalali month (00:00 Iran) for "monthly". Using a fixed boundary — instead of the
 * old rolling `now - 7/30 days` window — means a user's score only ever grows
 * within the period and resets cleanly at the boundary, so it no longer appears to
 * shrink as older activity falls out of a trailing window.
 * @param period - "weekly" or "monthly"
 * @param nowMs - Epoch ms the period is computed relative to
 * @returns The UTC datetime string marking the period's start
 */
function periodStartUtc(period: "weekly" | "monthly", nowMs: number): string {
  const startDate =
    period === "weekly" ? iranWeekStartDate(nowMs) : iranMonthStartDate(nowMs);
  return iranMidnightToUtc(startDate);
}

export interface LeaderboardEntry {
  rank: number;
  user_id: number;
  display_name: string;
  avatar_code: string | null;
  score: number;
}

export interface UserRank {
  rank: number;
  score: number;
}

/**
 * Fetch the XP leaderboard for a given time period.
 * @param env - The worker environment containing the D1 database binding
 * @param period - The leaderboard period: "weekly", "monthly", or "all"
 * @param limit - Maximum number of entries to return (default 50)
 * @returns An array of LeaderboardEntry objects ranked by XP
 */
export async function getLeaderboardXp(
  env: Env,
  period: LeaderboardPeriod,
  limit = 50,
  nowMs: number = Date.now()
): Promise<LeaderboardEntry[]> {
  if (period === "weekly" || period === "monthly") {
    // Fixed Iran-calendar boundary (Persian week / Jalali month), matching the
    // league — so the score only grows within the period and resets at the edge.
    // The full ranked snapshot is cached, so the top-`limit` slice is free.
    const standings = await getXpStandingsCached(env, period, nowMs);
    return standings.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      user_id: r.user_id,
      display_name: r.display_name,
      avatar_code: r.avatar_code,
      score: r.score,
    }));
  }

  // All-time: a single indexed read of users.xp_total — already fast, left uncached
  // so the all-time board stays exactly live.
  const rows = await queryAll<{
    user_id: number;
    display_name: string;
    avatar_code: string | null;
    score: number;
  }>(
    env,
    `
    SELECT u.id as user_id,
           COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
           u.avatar_code,
           u.xp_total as score
    FROM users u
    WHERE u.is_approved = 1
      AND (u.is_banned IS NULL OR u.is_banned = 0)
      AND u.xp_total > 0
    ORDER BY u.xp_total DESC, u.id ASC
    LIMIT ?
    `,
    [limit]
  );

  return rows.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id as number,
    display_name: r.display_name as string,
    avatar_code: (r.avatar_code as string | null) || null,
    score: (r.score as number) || 0,
  }));
}

/**
 * Get a specific user's rank and score on the XP leaderboard.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to look up
 * @param period - The leaderboard period: "weekly", "monthly", or "all"
 * @returns The user's rank and score, or null if the user is not eligible
 */
export async function getUserRankXp(
  env: Env,
  userId: number,
  period: LeaderboardPeriod,
  nowMs: number = Date.now()
): Promise<UserRank | null> {
  if (period === "all") {
    const user = await queryOne<{ xp_total: number }>(
      env,
      `SELECT xp_total FROM users WHERE id = ? AND is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)`,
      [userId]
    );
    if (!user) return null;

    const result = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) as cnt FROM users
       WHERE is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)
         AND xp_total > ?`,
      [user.xp_total]
    );
    return { rank: (result?.cnt ?? 0) + 1, score: user.xp_total };
  }

  // Same fixed Iran-calendar boundary as getLeaderboardXp — derived from the SAME
  // cached snapshot so the board and the "your rank" line are always consistent.
  // The user's score is their entry in the snapshot (0 if they have no activity this
  // period, in which case the handler doesn't show the rank line). Rank is the count
  // of strictly-higher scores + 1, matching the old COUNT(... HAVING SUM > score).
  const standings = await getXpStandingsCached(env, period, nowMs);
  const me = standings.find((s) => s.user_id === userId);
  const score = me?.score ?? 0;
  // standings is sorted score DESC, so the first entry with score <= ours marks the
  // end of the strictly-higher run — that index IS the count of higher scores.
  const firstEqualOrLower = standings.findIndex((s) => s.score <= score);
  const higher = firstEqualOrLower === -1 ? standings.length : firstEqualOrLower;
  return { rank: higher + 1, score };
}

/**
 * A streak is ALIVE while its last streak day is today **or yesterday** (Iran
 * local): yesterday's streak is not broken yet — you have until the end of today
 * to extend it. Only a gap of two days or more lapses it.
 *
 * This is the same rule resolveStreakDisplay() (bot/handlers/profile.ts) uses for
 * the number on the profile screen. The live board used to require the last streak
 * day to be exactly TODAY, which silently disagreed: a user on day 3 who hadn't
 * done today's questions yet saw "🔥 ۳ روز" on their profile but was missing from
 * the "استریک فعال" board, while someone who had just started (day 1) and studied
 * today was on it. Keeping the two rules identical is what fixes that.
 *
 * The bound is a date STRING comparison, which is chronological for 'YYYY-MM-DD',
 * and it takes the same TIME_ZONE_OFFSET parameter the rest of the file binds.
 */
const STREAK_ALIVE_SQL = `last_streak_date >= date('now', ?, '-1 day')`;

/**
 * Fetch the streak leaderboard (live streaks or all-time records).
 * @param env - The worker environment containing the D1 database binding
 * @param type - Whether to show "live" current streaks or all-time "record" streaks
 * @param limit - Maximum number of entries to return (default 50)
 * @returns An array of LeaderboardEntry objects ranked by streak count
 */
export async function getLeaderboardStreak(
  env: Env,
  type: StreakType,
  limit = 50
): Promise<LeaderboardEntry[]> {
  const TIME_MODIFIER = TIME_ZONE_OFFSET;
  let rows: LeaderboardEntry[];

  if (type === "live") {
    rows = await queryAll(
      env,
      `
      SELECT u.id as user_id,
             COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
             u.avatar_code,
             u.streak_count as score
      FROM users u
      WHERE u.is_approved = 1
        AND (u.is_banned IS NULL OR u.is_banned = 0)
        AND u.${STREAK_ALIVE_SQL}
        AND u.streak_count > 0
      ORDER BY u.streak_count DESC, u.id ASC
      LIMIT ?
      `,
      [TIME_MODIFIER, limit]
    );
  } else {
    rows = await queryAll(
      env,
      `
      SELECT u.id as user_id,
             COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
             u.avatar_code,
             u.max_streak_record as score
      FROM users u
      WHERE u.is_approved = 1
        AND (u.is_banned IS NULL OR u.is_banned = 0)
        AND u.max_streak_record > 0
      ORDER BY u.max_streak_record DESC, u.id ASC
      LIMIT ?
      `,
      [limit]
    );
  }

  return rows.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id as number,
    display_name: r.display_name as string,
    avatar_code: (r.avatar_code as string | null) || null,
    score: (r.score as number) || 0,
  }));
}

/**
 * Get a specific user's rank and score on the streak leaderboard.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to look up
 * @param type - Whether to check "live" current streak or all-time "record"
 * @returns The user's rank and streak score, or null if the user is not eligible
 */
export async function getUserRankStreak(
  env: Env,
  userId: number,
  type: StreakType
): Promise<UserRank | null> {
  const user = await queryOne<{ streak_count: number; max_streak_record: number; streak_alive: number }>(
    env,
    `SELECT streak_count, max_streak_record,
            CASE WHEN ${STREAK_ALIVE_SQL} THEN 1 ELSE 0 END as streak_alive
     FROM users WHERE id = ? AND is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)`,
    [TIME_ZONE_OFFSET, userId]
  );
  if (!user) return null;

  let rank = 0;
  let score = 0;

  if (type === "live") {
    // A lapsed streak scores 0, not its stale stored count — users.streak_count is
    // only rewritten on the next study day, so someone who stopped a week ago still
    // carries their old number. Scoring it 0 keeps the "📍 رتبه شما" line off
    // (the handler only shows it above 0) instead of advertising a dead streak.
    score = user.streak_alive === 1 ? user.streak_count : 0;
    const result = await queryOne<{ cnt: number }>(
      env,
      `
      SELECT COUNT(*) as cnt FROM users
      WHERE is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)
        AND ${STREAK_ALIVE_SQL}
        AND streak_count > ?
      `,
      [TIME_ZONE_OFFSET, score]
    );
    rank = (result?.cnt ?? 0) + 1;
  } else {
    score = user.max_streak_record;
    const result = await queryOne<{ cnt: number }>(
      env,
      `
      SELECT COUNT(*) as cnt FROM users
      WHERE is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)
        AND max_streak_record > ?
      `,
      [score]
    );
    rank = (result?.cnt ?? 0) + 1;
  }

  return { rank, score };
}

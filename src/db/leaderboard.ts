import { Env } from "../types";
import { queryAll, queryOne } from "./client";
import { TIME_ZONE_OFFSET } from "../config/constants";

export type LeaderboardPeriod = "weekly" | "monthly" | "all";
export type StreakType = "live" | "record";

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

// ============================================================
// XP Leaderboard
// ============================================================

export async function getLeaderboardXp(
  env: Env,
  period: LeaderboardPeriod,
  limit = 10
): Promise<LeaderboardEntry[]> {
  const TIME_MODIFIER = TIME_ZONE_OFFSET;
  let rows: any[];

  if (period === "weekly") {
    rows = await queryAll(
      env,
      `
      SELECT u.id as user_id,
             COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
             u.avatar_code,
             COALESCE(SUM(al.xp_delta), 0) as score
      FROM users u
      LEFT JOIN activity_log al ON al.user_id = u.id
        AND al.created_at >= datetime('now', '-7 days', ?)
      WHERE u.is_approved = 1
        AND (u.is_banned IS NULL OR u.is_banned = 0)
      GROUP BY u.id
      HAVING score > 0
      ORDER BY score DESC, u.id ASC
      LIMIT ?
      `,
      [TIME_MODIFIER, limit]
    );
  } else if (period === "monthly") {
    rows = await queryAll(
      env,
      `
      SELECT u.id as user_id,
             COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
             u.avatar_code,
             COALESCE(SUM(al.xp_delta), 0) as score
      FROM users u
      LEFT JOIN activity_log al ON al.user_id = u.id
        AND al.created_at >= datetime('now', '-30 days', ?)
      WHERE u.is_approved = 1
        AND (u.is_banned IS NULL OR u.is_banned = 0)
      GROUP BY u.id
      HAVING score > 0
      ORDER BY score DESC, u.id ASC
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
  }

  return rows.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id as number,
    display_name: r.display_name as string,
    avatar_code: (r.avatar_code as string | null) || null,
    score: (r.score as number) || 0,
  }));
}

export async function getUserRankXp(
  env: Env,
  userId: number,
  period: LeaderboardPeriod
): Promise<UserRank | null> {
  const TIME_MODIFIER = TIME_ZONE_OFFSET;

  const user = await queryOne<{ score: number }>(
    env,
    `SELECT xp_total as score FROM users WHERE id = ? AND is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)`,
    [userId]
  );
  if (!user) return null;

  let rank = 0;

  if (period === "weekly") {
    const result = await queryOne<{ cnt: number }>(
      env,
      `
      SELECT COUNT(*) as cnt FROM (
        SELECT u.id, COALESCE(SUM(al.xp_delta), 0) as s
        FROM users u
        LEFT JOIN activity_log al ON al.user_id = u.id
          AND al.created_at >= datetime('now', '-7 days', ?)
        WHERE u.is_approved = 1 AND (u.is_banned IS NULL OR u.is_banned = 0)
        GROUP BY u.id
        HAVING s > (SELECT COALESCE(SUM(xp_delta),0) FROM activity_log WHERE user_id = ? AND created_at >= datetime('now', '-7 days', ?))
      )
      `,
      [TIME_MODIFIER, userId, TIME_MODIFIER]
    );
    rank = (result?.cnt ?? 0) + 1;
  } else if (period === "monthly") {
    const result = await queryOne<{ cnt: number }>(
      env,
      `
      SELECT COUNT(*) as cnt FROM (
        SELECT u.id, COALESCE(SUM(al.xp_delta), 0) as s
        FROM users u
        LEFT JOIN activity_log al ON al.user_id = u.id
          AND al.created_at >= datetime('now', '-30 days', ?)
        WHERE u.is_approved = 1 AND (u.is_banned IS NULL OR u.is_banned = 0)
        GROUP BY u.id
        HAVING s > (SELECT COALESCE(SUM(xp_delta),0) FROM activity_log WHERE user_id = ? AND created_at >= datetime('now', '-30 days', ?))
      )
      `,
      [TIME_MODIFIER, userId, TIME_MODIFIER]
    );
    rank = (result?.cnt ?? 0) + 1;
  } else {
    const result = await queryOne<{ cnt: number }>(
      env,
      `
      SELECT COUNT(*) as cnt FROM users
      WHERE is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)
        AND xp_total > (SELECT xp_total FROM users WHERE id = ?)
      `,
      [userId]
    );
    rank = (result?.cnt ?? 0) + 1;
  }

  return { rank, score: user.score };
}

// ============================================================
// Streak Leaderboard
// ============================================================

export async function getLeaderboardStreak(
  env: Env,
  type: StreakType,
  limit = 10
): Promise<LeaderboardEntry[]> {
  const TIME_MODIFIER = TIME_ZONE_OFFSET;
  let rows: any[];

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
        AND u.last_streak_date = date('now', ?)
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

export async function getUserRankStreak(
  env: Env,
  userId: number,
  type: StreakType
): Promise<UserRank | null> {
  const user = await queryOne<{ streak_count: number; max_streak_record: number }>(
    env,
    `SELECT streak_count, max_streak_record FROM users WHERE id = ? AND is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)`,
    [userId]
  );
  if (!user) return null;

  let rank = 0;
  let score = 0;

  if (type === "live") {
    score = user.streak_count;
    const result = await queryOne<{ cnt: number }>(
      env,
      `
      SELECT COUNT(*) as cnt FROM users
      WHERE is_approved = 1 AND (is_banned IS NULL OR is_banned = 0)
        AND last_streak_date = date('now', ?)
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

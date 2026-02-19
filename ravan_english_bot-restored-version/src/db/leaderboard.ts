import { Env } from "../types";
import { queryAll, queryOne } from "./client";

export type LeaderboardPeriod = "weekly" | "monthly" | "all_time";

export interface LeaderboardRow {
  user_id: number;
  display_name: string | null;
  xp: number;
}

export interface UserRankInfo {
  rank: number;
  xp: number;
}

// بازه‌ی زمانی برای weekly / monthly
function getDateFilter(period: LeaderboardPeriod): string | null {
  if (period === "weekly") {
    return "datetime('now', '-7 days')";
  }
  if (period === "monthly") {
    return "datetime('now', '-30 days')";
  }
  return null;
}

// لیست برترین‌ها
export async function getLeaderboard(
  env: Env,
  period: LeaderboardPeriod,
  limit: number = 10
): Promise<LeaderboardRow[]> {
  if (period === "all_time") {
    const rows = await queryAll<LeaderboardRow>(
      env,
      `
      SELECT
        id AS user_id,
        display_name,
        xp_total AS xp
      FROM users
      WHERE xp_total > 0
      ORDER BY xp_total DESC, id ASC
      LIMIT ?
      `,
      [limit]
    );
    return rows;
  }

  const since = getDateFilter(period)!;

  const rows = await queryAll<LeaderboardRow>(
    env,
    `
    SELECT
      u.id AS user_id,
      u.display_name,
      SUM(a.xp_delta) AS xp
    FROM users u
    JOIN activity_log a ON a.user_id = u.id
    WHERE a.created_at >= ${since}
    GROUP BY u.id, u.display_name
    HAVING xp > 0
    ORDER BY xp DESC, u.id ASC
    LIMIT ?
    `,
    [limit]
  );

  return rows;
}

// رتبه و XP یک کاربر در یک بازه
export async function getUserRank(
  env: Env,
  period: LeaderboardPeriod,
  userId: number
): Promise<UserRankInfo | null> {
  if (period === "all_time") {
    const userRow = await queryOne<{ xp_total: number | null }>(
      env,
      `
      SELECT xp_total
      FROM users
      WHERE id = ?
      `,
      [userId]
    );

    const xpTotal = userRow?.xp_total ?? 0;
    if (xpTotal <= 0) {
      return null;
    }

    const rankRow = await queryOne<{ rank: number }>(
      env,
      `
      SELECT COUNT(*) + 1 AS rank
      FROM users
      WHERE xp_total > ?
      `,
      [xpTotal]
    );

    return {
      rank: rankRow?.rank ?? 1,
      xp: xpTotal
    };
  }

  const since = getDateFilter(period)!;

  const xpRow = await queryOne<{ xp: number | null }>(
    env,
    `
    SELECT
      SUM(a.xp_delta) AS xp
    FROM activity_log a
    WHERE a.user_id = ?
      AND a.created_at >= ${since}
    `,
    [userId]
  );

  const xp = xpRow?.xp ?? 0;
  if (xp <= 0) {
    return null;
  }

  const rankRow = await queryOne<{ rank: number }>(
    env,
    `
    SELECT
      COUNT(*) + 1 AS rank
    FROM (
      SELECT
        user_id,
        SUM(xp_delta) AS xp
      FROM activity_log
      WHERE created_at >= ${since}
      GROUP BY user_id
    ) t
    WHERE t.xp > ?
    `,
    [xp]
  );

  return {
    rank: rankRow?.rank ?? 1,
    xp
  };
}

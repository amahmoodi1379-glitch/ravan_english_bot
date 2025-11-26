import { Env } from "../types";
import { queryOne, execute } from "./client";

export type ActivityPeriod = "day" | "week" | "month" | "all";

export interface UserProfile {
  id: number;
  display_name: string | null;
  avatar_code: string | null;
  xp_total: number;
  created_at: string;
  last_seen_at: string | null;
  name_change_count: number;
}

export interface ActivityStats {
  period: ActivityPeriod;
  xp: number;
  leitner_questions: number;
  reading_sets: number;
  duels: number;
  reflections: number;
}

export interface NameChangeResult {
  ok: boolean;
  reason?: "limit" | "not_found";
  remainingChanges?: number;
}

function getSinceExpr(period: ActivityPeriod): string | null {
  if (period === "day") return "datetime('now', '-1 day')";
  if (period === "week") return "datetime('now', '-7 days')";
  if (period === "month") return "datetime('now', '-30 days')";
  return null;
}

export async function getUserProfile(env: Env, userId: number): Promise<UserProfile | null> {
  const row = await queryOne<UserProfile>(
    env,
    `
    SELECT
      id,
      display_name,
      avatar_code,
      xp_total,
      created_at,
      last_seen_at,
      name_change_count
    FROM users
    WHERE id = ?
    `,
    [userId]
  );
  return row ?? null;
}

export async function updateDisplayName(
  env: Env,
  userId: number,
  newName: string
): Promise<NameChangeResult> {
  const row = await queryOne<{ name_change_count: number }>(
    env,
    `
    SELECT name_change_count
    FROM users
    WHERE id = ?
    `,
    [userId]
  );

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  const currentCount = row.name_change_count ?? 0;
  if (currentCount >= 3) {
    return { ok: false, reason: "limit", remainingChanges: 0 };
  }

  const now = new Date().toISOString();

  await execute(
    env,
    `
    UPDATE users
    SET display_name = ?, name_change_count = name_change_count + 1, updated_at = ?
    WHERE id = ?
    `,
    [newName, now, userId]
  );

  const remaining = Math.max(0, 3 - (currentCount + 1));

  return {
    ok: true,
    remainingChanges: remaining
  };
}

export async function setAvatar(env: Env, userId: number, avatarCode: string): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    env,
    `
    UPDATE users
    SET avatar_code = ?, updated_at = ?
    WHERE id = ?
    `,
    [avatarCode, now, userId]
  );
}

export async function getUserActivityStats(
  env: Env,
  userId: number,
  period: ActivityPeriod
): Promise<ActivityStats> {
  const sinceExpr = getSinceExpr(period);

  let xp = 0;
  let leitnerQuestions = 0;
  let readingSets = 0;
  let duels = 0;
  let reflections = 0;

  if (!sinceExpr) {
    // --- حالت کلی (All Time) ---
    
    // 1. XP کل
    const xpRow = await queryOne<{ xp: number | null }>(
      env,
      `SELECT xp_total AS xp FROM users WHERE id = ?`,
      [userId]
    );
    xp = xpRow?.xp ?? 0;

    // 2. لایتنر
    const lRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM user_word_question_history WHERE user_id = ? AND context = 'leitner'`,
      [userId]
    );
    leitnerQuestions = lRow?.cnt ?? 0;

    // 3. درک مطلب
    const rRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM reading_sessions WHERE user_id = ? AND status = 'completed'`,
      [userId]
    );
    readingSets = rRow?.cnt ?? 0;

    // 4. دوئل
    const dRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM duel_matches WHERE status = 'completed' AND (player1_id = ? OR player2_id = ?)`,
      [userId, userId]
    );
    duels = dRow?.cnt ?? 0;

    // 5. برداشت از متن (Reflection) - NEW
    const refRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM reflection_sessions WHERE user_id = ? AND ai_score IS NOT NULL`,
      [userId]
    );
    reflections = refRow?.cnt ?? 0;

  } else {
    // --- حالت بازه زمانی (Day / Week / Month) ---

    // 1. XP در بازه
    const xpRow = await queryOne<{ xp: number | null }>(
      env,
      `SELECT COALESCE(SUM(xp_delta), 0) AS xp FROM activity_log WHERE user_id = ? AND created_at >= ${sinceExpr}`,
      [userId]
    );
    xp = xpRow?.xp ?? 0;

    // 2. لایتنر در بازه
    const lRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM user_word_question_history WHERE user_id = ? AND context = 'leitner' AND answered_at >= ${sinceExpr}`,
      [userId]
    );
    leitnerQuestions = lRow?.cnt ?? 0;

    // 3. درک مطلب در بازه
    const rRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM reading_sessions WHERE user_id = ? AND status = 'completed' AND completed_at >= ${sinceExpr}`,
      [userId]
    );
    readingSets = rRow?.cnt ?? 0;

    // 4. دوئل در بازه
    const dRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM duel_matches WHERE status = 'completed' AND completed_at >= ${sinceExpr} AND (player1_id = ? OR player2_id = ?)`,
      [userId, userId]
    );
    duels = dRow?.cnt ?? 0;

    // 5. برداشت از متن در بازه - NEW
    const refRow = await queryOne<{ cnt: number }>(
      env,
      `SELECT COUNT(*) AS cnt FROM reflection_sessions WHERE user_id = ? AND ai_score IS NOT NULL AND created_at >= ${sinceExpr}`,
      [userId]
    );
    reflections = refRow?.cnt ?? 0;
  }

  return {
    period,
    xp,
    leitner_questions: leitnerQuestions,
    reading_sets: readingSets,
    duels,
    reflections
  };
}

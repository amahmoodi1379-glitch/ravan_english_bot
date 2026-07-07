import { Env } from "../types";
import { queryAll, queryOne, prepare, batch } from "./client";
import { getUserActivityStats } from "./profile";
import {
  THRESHOLD_BADGES,
  ThresholdMetric,
  BadgeDef,
  badgeByCode,
  leagueTierBadgeCode,
} from "../config/badges";

/** Max prepared statements per DB.batch(). */
const BADGE_BATCH_CHUNK = 100;

export interface UserBadgeRow {
  badge_code: string;
  awarded_at: string;
}

/** The set of badge codes a user has already earned. */
export async function getUserBadgeCodes(env: Env, userId: number): Promise<Set<string>> {
  const rows = await queryAll<{ badge_code: string }>(
    env,
    `SELECT badge_code FROM user_badges WHERE user_id = ?`,
    [userId]
  );
  return new Set(rows.map((r) => r.badge_code));
}

/** All of a user's earned badges with award timestamps (for the medals page). */
export async function getUserBadges(env: Env, userId: number): Promise<UserBadgeRow[]> {
  return queryAll<UserBadgeRow>(
    env,
    `SELECT badge_code, awarded_at FROM user_badges WHERE user_id = ? ORDER BY awarded_at ASC`,
    [userId]
  );
}

/**
 * Award the given badge codes to a user, once each. Returns only the codes that
 * were newly awarded (so the caller can notify). Idempotent: pre-filters against
 * existing badges and uses INSERT OR IGNORE as a second guard against races.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user to award to
 * @param codes - Candidate badge codes
 * @param meta - Optional context stored on each new row
 * @returns The subset of codes that were newly awarded
 */
export async function awardBadges(
  env: Env,
  userId: number,
  codes: string[],
  meta?: Record<string, unknown>
): Promise<string[]> {
  if (!codes.length) return [];
  const existing = await getUserBadgeCodes(env, userId);
  const fresh = [...new Set(codes)].filter((c) => !existing.has(c));
  if (!fresh.length) return [];

  const metaJson = meta ? JSON.stringify(meta) : null;
  const stmts = fresh.map((c) =>
    prepare(
      env,
      `INSERT OR IGNORE INTO user_badges (user_id, badge_code, meta_json) VALUES (?, ?, ?)`,
      [userId, c, metaJson]
    )
  );
  for (let i = 0; i < stmts.length; i += BADGE_BATCH_CHUNK) {
    await batch(env, stmts.slice(i, i + BADGE_BATCH_CHUNK));
  }
  return fresh;
}

/**
 * Evaluate threshold badges (streak / xp / words / reading) for a user against
 * their current all-time stats and award any newly-earned ones.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user to evaluate
 * @returns Definitions of the newly-awarded badges (for an immediate notification)
 */
export async function evaluateThresholdBadges(env: Env, userId: number): Promise<BadgeDef[]> {
  const [stats, streakRow] = await Promise.all([
    getUserActivityStats(env, userId, "all"),
    queryOne<{ m: number }>(env, `SELECT max_streak_record as m FROM users WHERE id = ?`, [userId]),
  ]);

  const metrics: Record<ThresholdMetric, number> = {
    streak: streakRow?.m ?? 0,
    xp: stats.xp,
    words: stats.new_words_learned,
    reading: stats.reading_sets,
  };

  const qualified = THRESHOLD_BADGES.filter((b) => metrics[b.metric] >= b.threshold).map((b) => b.code);
  const newCodes = await awardBadges(env, userId, qualified);
  return newCodes.map((c) => badgeByCode(c)).filter((b): b is BadgeDef => Boolean(b));
}

/** A tournament participant's outcome, used to decide event badges. */
export interface TournamentBadgeEntry {
  userId: number;
  rank: number;
  correct: number;
  total: number;
  participationCount: number; // lifetime finished tournaments (including this one)
}

/**
 * Award tournament event badges to participants at settlement.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The tournament's quiz id (stored as meta)
 * @param entries - Per-participant outcome data
 * @returns Map of userId → newly-awarded badge codes (for the results message)
 */
export async function awardTournamentBadges(
  env: Env,
  quizId: number,
  entries: TournamentBadgeEntry[]
): Promise<Map<number, string[]>> {
  const candidates = new Map<number, string[]>();
  for (const e of entries) {
    const codes: string[] = ["tourney_first"];
    if (e.participationCount >= 10) codes.push("tourney_10");
    if (e.participationCount >= 50) codes.push("tourney_50");
    if (e.participationCount >= 100) codes.push("tourney_100");
    if (e.rank <= 3) codes.push("tourney_top3");
    if (e.rank === 1) codes.push("tourney_win");
    if (e.total > 0 && e.correct === e.total) codes.push("tourney_perfect");
    candidates.set(e.userId, codes);
  }
  return bulkAwardBadges(env, candidates, { quiz_id: quizId });
}

/** A league participant's outcome, used to decide tier/champion badges. */
export interface LeagueBadgeEntry {
  userId: number;
  newTier: number;
  outcome: string; // promote | demote | stay | champion
}

/**
 * Award league event badges at settlement (tier reached + champion). Idempotent.
 * @param env - The worker environment containing the D1 database binding
 * @param weekStart - The settled week (stored as meta)
 * @param entries - Per-user league outcome data
 * @returns void
 */
export async function awardLeagueBadges(
  env: Env,
  weekStart: string,
  entries: LeagueBadgeEntry[]
): Promise<void> {
  const candidates = new Map<number, string[]>();
  for (const e of entries) {
    const codes: string[] = [];
    const tierCode = leagueTierBadgeCode(e.newTier);
    if (tierCode) codes.push(tierCode);
    if (e.outcome === "champion") codes.push("league_champion");
    if (codes.length) candidates.set(e.userId, codes);
  }
  await bulkAwardBadges(env, candidates, { week_start: weekStart });
}

/**
 * Award many users' event badges in bulk: one batched read of existing badges
 * for all users, then chunked batched inserts of only the new ones. Avoids the
 * N sequential queries a per-user loop would issue (Cloudflare subrequest/CPU
 * limits) at tournament/league settlement.
 * @param env - The worker environment containing the D1 database binding
 * @param candidatesByUser - userId → candidate badge codes to award
 * @param meta - Optional context stored on each new row (uniform per call)
 * @returns userId → newly-awarded badge codes
 */
async function bulkAwardBadges(
  env: Env,
  candidatesByUser: Map<number, string[]>,
  meta?: Record<string, unknown>
): Promise<Map<number, string[]>> {
  const userIds = [...candidatesByUser.keys()];
  if (!userIds.length) return new Map();

  // One read of existing badges for all involved users (chunked IN lists).
  const IN_CHUNK = 200;
  const existingByUser = new Map<number, Set<string>>();
  for (let i = 0; i < userIds.length; i += IN_CHUNK) {
    const chunk = userIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await queryAll<{ user_id: number; badge_code: string }>(
      env,
      `SELECT user_id, badge_code FROM user_badges WHERE user_id IN (${placeholders})`,
      chunk
    );
    for (const r of rows) {
      let s = existingByUser.get(r.user_id);
      if (!s) {
        s = new Set();
        existingByUser.set(r.user_id, s);
      }
      s.add(r.badge_code);
    }
  }

  const metaJson = meta ? JSON.stringify(meta) : null;
  const result = new Map<number, string[]>();
  const stmts: D1PreparedStatement[] = [];
  for (const [userId, codes] of candidatesByUser) {
    const existing = existingByUser.get(userId) ?? new Set<string>();
    const fresh: string[] = [];
    for (const code of new Set(codes)) {
      if (!existing.has(code)) {
        fresh.push(code);
        stmts.push(
          prepare(
            env,
            `INSERT OR IGNORE INTO user_badges (user_id, badge_code, meta_json) VALUES (?, ?, ?)`,
            [userId, code, metaJson]
          )
        );
      }
    }
    if (fresh.length) result.set(userId, fresh);
  }
  for (let i = 0; i < stmts.length; i += BADGE_BATCH_CHUNK) {
    await batch(env, stmts.slice(i, i + BADGE_BATCH_CHUNK));
  }
  return result;
}

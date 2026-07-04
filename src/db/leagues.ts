import { Env } from "../types";
import { queryOne, queryAll, execute, prepare, batch } from "./client";
import { LEAGUE_CONFIG } from "../config/constants";
import {
  iranWeekStartDate,
  shiftDateStr,
  iranMidnightToUtc,
} from "../utils/iran_time";

/** Max prepared statements per DB.batch() (kept well under D1 limits). */
const LEAGUE_BATCH_CHUNK = 100;

export interface LeagueSeason {
  week_start: string;
  week_end: string;
  status: string; // active | settled
  created_at: string;
  settled_at: string | null;
}

export interface LeagueDivision {
  id: number;
  week_start: string;
  tier: number;
  division_number: number;
  created_at: string;
}

export interface DivisionStanding {
  user_id: number;
  display_name: string;
  avatar_code: string | null;
  weekly_xp: number;
}

export interface UserLeagueView {
  weekStart: string;
  weekEnd: string;
  tier: number;
  tierName: string;
  divisionId: number;
  standings: DivisionStanding[]; // ranked (index 0 = rank 1)
  userRank: number;
  memberCount: number;
  promoteCount: number;
  demoteCount: number;
  maxTier: number;
}

export interface LeagueAnnounceRow {
  user_id: number;
  telegram_id: number;
  tier: number;
  new_tier: number;
  rank_in_division: number;
  weekly_xp: number;
  outcome: string;
}

/** Display name for a 1-indexed tier. */
export function tierName(tier: number): string {
  return LEAGUE_CONFIG.TIERS[tier - 1] ?? `سطح ${tier}`;
}

/** The number of tiers configured (top tier index). */
function maxTier(): number {
  return LEAGUE_CONFIG.TIERS.length;
}

/** UTC datetime bounds for an Iran-local week identified by its Saturday date. */
function weekBoundsUtc(weekStart: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: iranMidnightToUtc(weekStart),
    endUtc: iranMidnightToUtc(shiftDateStr(weekStart, 7)),
  };
}

/** Fisher-Yates shuffle (returns a new array). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Ensure a league_seasons row exists for the given week (no-op if present). */
async function ensureSeason(env: Env, weekStart: string): Promise<void> {
  await execute(
    env,
    `INSERT OR IGNORE INTO league_seasons (week_start, week_end, status) VALUES (?, ?, 'active')`,
    [weekStart, shiftDateStr(weekStart, 7)]
  );
}

/**
 * Ensure the user is enrolled in the current week's league; new / returning users
 * are lazily placed into a bronze (tier 1) division with capacity, creating a new
 * bronze division if all are full. Idempotent per (week, user).
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user id to enroll
 * @param nowMs - Optional epoch ms (defaults to now)
 * @returns void
 */
export async function ensureLeagueMembership(
  env: Env,
  userId: number,
  nowMs: number = Date.now()
): Promise<void> {
  const weekStart = iranWeekStartDate(nowMs);
  const existing = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM league_members WHERE week_start = ? AND user_id = ?`,
    [weekStart, userId]
  );
  if (existing) return;

  await ensureSeason(env, weekStart);

  const div = await queryOne<{ id: number }>(
    env,
    `SELECT d.id FROM league_divisions d
     WHERE d.week_start = ? AND d.tier = 1
       AND (SELECT COUNT(*) FROM league_members m WHERE m.division_id = d.id) < ?
     ORDER BY d.division_number ASC LIMIT 1`,
    [weekStart, LEAGUE_CONFIG.DIVISION_SIZE]
  );

  let divisionId: number;
  if (div) {
    divisionId = div.id;
  } else {
    const maxRow = await queryOne<{ n: number }>(
      env,
      `SELECT COALESCE(MAX(division_number), 0) as n FROM league_divisions WHERE week_start = ? AND tier = 1`,
      [weekStart]
    );
    const res = await execute(
      env,
      `INSERT INTO league_divisions (week_start, tier, division_number) VALUES (?, 1, ?)`,
      [weekStart, (maxRow?.n ?? 0) + 1]
    );
    divisionId = (res.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
  }

  try {
    await execute(
      env,
      `INSERT INTO league_members (week_start, user_id, division_id, tier) VALUES (?, ?, ?, 1)`,
      [weekStart, userId, divisionId]
    );
  } catch {
    // UNIQUE(week_start, user_id) race — a concurrent request already enrolled them.
  }
}

/**
 * Ranked standings for a division in a given week (XP summed over the week window).
 * @param env - The worker environment containing the D1 database binding
 * @param weekStart - Iran-local Saturday date of the week
 * @param divisionId - The division id
 * @returns Standings ordered by weekly XP desc, then user_id asc (deterministic)
 */
export async function getDivisionStandings(
  env: Env,
  weekStart: string,
  divisionId: number
): Promise<DivisionStanding[]> {
  const { startUtc, endUtc } = weekBoundsUtc(weekStart);
  return queryAll<DivisionStanding>(
    env,
    `
    SELECT lm.user_id,
      COALESCE(u.display_name, u.first_name, u.username, 'user_' || u.id) as display_name,
      u.avatar_code,
      COALESCE(SUM(al.xp_delta), 0) as weekly_xp
    FROM league_members lm
    JOIN users u ON u.id = lm.user_id
    LEFT JOIN activity_log al
      ON al.user_id = lm.user_id
     AND al.created_at >= ?
     AND al.created_at <  ?
    WHERE lm.week_start = ? AND lm.division_id = ?
    GROUP BY lm.user_id
    ORDER BY weekly_xp DESC, lm.user_id ASC
    `,
    [startUtc, endUtc, weekStart, divisionId]
  );
}

/**
 * Build the current-week league view for a user (enrolling them lazily if needed).
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user id
 * @param nowMs - Optional epoch ms (defaults to now)
 * @returns The user's division view, or null if enrollment failed
 */
export async function getUserLeagueState(
  env: Env,
  userId: number,
  nowMs: number = Date.now()
): Promise<UserLeagueView | null> {
  await ensureLeagueMembership(env, userId, nowMs);
  const weekStart = iranWeekStartDate(nowMs);
  const member = await queryOne<{ division_id: number; tier: number }>(
    env,
    `SELECT division_id, tier FROM league_members WHERE week_start = ? AND user_id = ?`,
    [weekStart, userId]
  );
  if (!member) return null;

  const standings = await getDivisionStandings(env, weekStart, member.division_id);
  const userRank = standings.findIndex((s) => s.user_id === userId) + 1;

  return {
    weekStart,
    weekEnd: shiftDateStr(weekStart, 7),
    tier: member.tier,
    tierName: tierName(member.tier),
    divisionId: member.division_id,
    standings,
    userRank,
    memberCount: standings.length,
    promoteCount: LEAGUE_CONFIG.PROMOTE_COUNT,
    demoteCount: LEAGUE_CONFIG.DEMOTE_COUNT,
    maxTier: maxTier(),
  };
}

/**
 * Settle the just-ended league week: rank each division, decide promote / demote /
 * stay / champion / removed, freeze results, and form next week's divisions.
 * Idempotent — skips if the ended week is already settled; the ended season is
 * marked settled LAST so a mid-run failure can safely resume.
 * @param env - The worker environment containing the D1 database binding
 * @param nowMs - Optional epoch ms (defaults to now; use the Saturday-00:00 tick)
 * @returns The Iran-local week_start that was settled, or null if nothing to do
 */
export async function settleLeague(env: Env, nowMs: number = Date.now()): Promise<string | null> {
  const thisWeek = iranWeekStartDate(nowMs);
  const endedWeek = shiftDateStr(thisWeek, -7);

  const endedSeason = await queryOne<LeagueSeason>(
    env,
    `SELECT * FROM league_seasons WHERE week_start = ?`,
    [endedWeek]
  );
  if (endedSeason && endedSeason.status === "settled") return null;

  const divisions = await queryAll<LeagueDivision>(
    env,
    `SELECT * FROM league_divisions WHERE week_start = ? ORDER BY tier ASC, division_number ASC`,
    [endedWeek]
  );

  const top = maxTier();
  const resultStmts: D1PreparedStatement[] = [];
  const nextTierByUser = new Map<number, number>();

  for (const div of divisions) {
    const standings = await getDivisionStandings(env, endedWeek, div.id);
    const n = standings.length;
    standings.forEach((s, idx) => {
      const rank = idx + 1;
      const tier = div.tier;
      let outcome: string;
      let newTier: number;

      if (s.weekly_xp <= 0) {
        // Inactive: drop out of the league; rejoins bronze lazily on return.
        outcome = "removed";
        newTier = tier;
      } else if (rank <= LEAGUE_CONFIG.PROMOTE_COUNT && tier < top) {
        outcome = "promote";
        newTier = tier + 1;
      } else if (rank <= LEAGUE_CONFIG.PROMOTE_COUNT && tier === top) {
        outcome = "champion";
        newTier = tier;
      } else if (rank > n - LEAGUE_CONFIG.DEMOTE_COUNT && tier > 1) {
        outcome = "demote";
        newTier = tier - 1;
      } else {
        outcome = "stay";
        newTier = tier;
      }

      resultStmts.push(
        prepare(
          env,
          `INSERT OR REPLACE INTO league_results
             (week_start, user_id, tier, division_id, rank_in_division, weekly_xp, outcome, new_tier)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [endedWeek, s.user_id, tier, div.id, rank, s.weekly_xp, outcome, newTier]
        )
      );
      if (outcome !== "removed") nextTierByUser.set(s.user_id, newTier);
    });
  }

  for (let i = 0; i < resultStmts.length; i += LEAGUE_BATCH_CHUNK) {
    await batch(env, resultStmts.slice(i, i + LEAGUE_BATCH_CHUNK));
  }

  // Form next week's divisions from surviving members (only once).
  await ensureSeason(env, thisWeek);
  const built = await queryOne<{ c: number }>(
    env,
    `SELECT COUNT(*) as c FROM league_divisions WHERE week_start = ?`,
    [thisWeek]
  );
  if (!built || built.c === 0) {
    const usersByTier = new Map<number, number[]>();
    for (const [userId, tier] of nextTierByUser) {
      const arr = usersByTier.get(tier) ?? [];
      arr.push(userId);
      usersByTier.set(tier, arr);
    }
    for (let tier = 1; tier <= top; tier++) {
      const users = shuffle(usersByTier.get(tier) ?? []);
      let divisionNumber = 1;
      for (let i = 0; i < users.length; i += LEAGUE_CONFIG.DIVISION_SIZE) {
        const chunk = users.slice(i, i + LEAGUE_CONFIG.DIVISION_SIZE);
        const res = await execute(
          env,
          `INSERT INTO league_divisions (week_start, tier, division_number) VALUES (?, ?, ?)`,
          [thisWeek, tier, divisionNumber++]
        );
        const divId = (res.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
        const memberStmts = chunk.map((uid) =>
          prepare(
            env,
            `INSERT OR IGNORE INTO league_members (week_start, user_id, division_id, tier) VALUES (?, ?, ?, ?)`,
            [thisWeek, uid, divId, tier]
          )
        );
        for (let j = 0; j < memberStmts.length; j += LEAGUE_BATCH_CHUNK) {
          await batch(env, memberStmts.slice(j, j + LEAGUE_BATCH_CHUNK));
        }
      }
    }
  }

  // Mark the ended week settled LAST (so a crash before this re-runs cleanly).
  await execute(
    env,
    `UPDATE league_seasons SET status = 'settled', settled_at = datetime('now') WHERE week_start = ?`,
    [endedWeek]
  );
  await execute(
    env,
    `INSERT OR IGNORE INTO league_seasons (week_start, week_end, status, settled_at)
     VALUES (?, ?, 'settled', datetime('now'))`,
    [endedWeek, thisWeek]
  );

  return endedWeek;
}

/**
 * Frozen results for a settled week, joined to telegram_id, for announcement.
 * Only active participants (weekly_xp > 0, not banned) are returned.
 * @param env - The worker environment containing the D1 database binding
 * @param weekStart - The settled week's Iran-local Saturday date
 * @returns Announcement rows
 */
export async function getSettledResultsForWeek(
  env: Env,
  weekStart: string
): Promise<LeagueAnnounceRow[]> {
  return queryAll<LeagueAnnounceRow>(
    env,
    `
    SELECT r.user_id, u.telegram_id, r.tier, r.new_tier, r.rank_in_division, r.weekly_xp, r.outcome
    FROM league_results r
    JOIN users u ON u.id = r.user_id
    WHERE r.week_start = ? AND r.weekly_xp > 0 AND COALESCE(u.is_banned, 0) = 0
    ORDER BY r.tier DESC, r.rank_in_division ASC
    `,
    [weekStart]
  );
}

/** The Iran-local week_start of the week that most recently ended (for announcements). */
export function lastEndedWeekStart(nowMs: number = Date.now()): string {
  return shiftDateStr(iranWeekStartDate(nowMs), -7);
}

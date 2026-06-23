import { Env } from "../types";
import { queryAll, execute } from "./client";

export interface InactiveUserRow {
  id: number;
  telegram_id: number;
  inactivity_reminder_stage: number;
  days_inactive: number;
}

/**
 * Find active subscribers who have been inactive for >= 2 days and still have a
 * pending reminder stage (stage < 3). The caller decides which stage to fire based
 * on days_inactive (2 / 5 / 10 day thresholds).
 * @param env - The worker environment containing the D1 database binding
 * @returns Candidate users with their current reminder stage and whole days inactive
 */
export async function getUsersForInactivityReminder(env: Env): Promise<InactiveUserRow[]> {
  return await queryAll<InactiveUserRow>(
    env,
    `
    SELECT
      id,
      telegram_id,
      inactivity_reminder_stage,
      CAST(julianday('now') - julianday(last_seen_at) AS INTEGER) AS days_inactive
    FROM users
    WHERE is_approved = 1
      AND COALESCE(is_banned, 0) = 0
      AND last_seen_at IS NOT NULL
      AND inactivity_reminder_stage < 3
      -- SARGable: last_seen_at is stored as ISO (toISOString); compare against an
      -- ISO-formatted threshold rather than wrapping the column in julianday().
      AND last_seen_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')
    `,
    []
  );
}

/**
 * Persist the reminder stage that was just sent to a user.
 * @param env - The worker environment containing the D1 database binding
 * @param userId - The user ID to update
 * @param stage - The reminder stage value (1, 2, or 3)
 * @returns void
 */
export async function setReminderStage(env: Env, userId: number, stage: number): Promise<void> {
  await execute(env, `UPDATE users SET inactivity_reminder_stage = ? WHERE id = ?`, [stage, userId]);
}

export interface ReportRecipient {
  id: number;
  telegram_id: number;
  display_name: string | null;
}

/**
 * Find active subscribers who had at least one XP-earning activity inside the
 * given local-date window [curStart, curEnd). Used to avoid sending "zero vs zero"
 * progress reports to inactive users.
 * @param env - The worker environment containing the D1 database binding
 * @param curStart - Inclusive start local date 'YYYY-MM-DD'
 * @param curEnd - Exclusive end local date 'YYYY-MM-DD'
 * @returns The recipients who were active in the window
 */
export async function getActiveUsersForReport(
  env: Env,
  curStart: string,
  curEnd: string
): Promise<ReportRecipient[]> {
  return await queryAll<ReportRecipient>(
    env,
    `
    SELECT u.id, u.telegram_id, u.display_name
    FROM users u
    WHERE u.is_approved = 1
      AND COALESCE(u.is_banned, 0) = 0
      AND EXISTS (
        SELECT 1 FROM activity_log a
        WHERE a.user_id = u.id
          -- SARGable: convert the local-date bounds to UTC datetime so the
          -- (user_id, created_at) index range can be used (activity_log.created_at
          -- is stored via datetime('now')).
          AND a.created_at >= datetime(?, '-3.5 hours')
          AND a.created_at < datetime(?, '-3.5 hours')
      )
    `,
    [curStart, curEnd]
  );
}

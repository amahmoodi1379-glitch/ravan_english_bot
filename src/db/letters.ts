import { Env } from "../types";
import { queryOne, queryAll, execute } from "./client";
import { LETTERS, TIME_ZONE_OFFSET } from "../config/constants";

/**
 * Data-access + domain logic for the standalone "Letters" (نامه‌ها) feature.
 *
 * Model: a new letter fans out to up to 5 eligible recipients, each becoming an
 * independent 1:1 thread (letter_threads). Every actual message/reply is a row
 * in letter_messages, which doubles as the delivery record (recipient_user_id,
 * is_read, replied_at). sender_nickname is snapshotted on each row so nickname
 * changes never rewrite history. Blocks (letter_blocks) are keyed on real user
 * ids, so they survive nickname changes.
 */

export interface LetterUser {
  user_id: number;
  nickname: string;
  notif_enabled: number;
  receiving_disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LetterMessage {
  id: number;
  thread_id: number;
  sender_user_id: number;
  recipient_user_id: number;
  sender_nickname: string;
  body: string;
  is_reply: number;
  ref_message_id: number | null;
  is_read: number;
  replied_at: string | null;
  created_at: string;
}

export interface EligibleRecipient {
  id: number;
  telegram_id: number;
  nickname: string;
  notif_enabled: number;
  received_count: number;
}

/** A delivered message ready to be (optionally) notified to its recipient. */
export interface LetterDelivery {
  recipientUserId: number;
  telegramId: number;
  messageId: number;
  notifEnabled: boolean;
}

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────

/** True if the user has fully disabled receiving letters. */
export function isReceivingDisabled(lu: Pick<LetterUser, "receiving_disabled_at">): boolean {
  return lu.receiving_disabled_at != null;
}

/**
 * Milliseconds remaining on the 7-day re-enable lock. <= 0 means the lock has
 * expired (or receiving was never disabled) and the user may re-enable.
 */
export function disableLockRemainingMs(
  lu: Pick<LetterUser, "receiving_disabled_at">,
  nowMs: number
): number {
  if (!lu.receiving_disabled_at) return 0;
  const disabledMs = Date.parse(lu.receiving_disabled_at.replace(" ", "T") + "Z");
  if (Number.isNaN(disabledMs)) return 0;
  const unlockMs = disabledMs + LETTERS.DISABLE_LOCK_DAYS * 24 * 60 * 60 * 1000;
  return unlockMs - nowMs;
}

/**
 * Whether a received message should still appear in / be answerable from the
 * inbox. Unanswered original letters expire after 7 days; replies persist until
 * answered (or the 30-day purge). Answered items leave the inbox immediately.
 */
export function isInboxVisible(
  msg: Pick<LetterMessage, "is_reply" | "replied_at" | "created_at">,
  nowMs: number
): boolean {
  if (msg.replied_at != null) return false;
  if (msg.is_reply === 1) return true;
  const createdMs = Date.parse(msg.created_at.replace(" ", "T") + "Z");
  if (Number.isNaN(createdMs)) return true;
  return nowMs - createdMs <= LETTERS.INBOX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

/** Validate a chosen nickname: non-empty, not too long, no links/handles/phones. */
export function validateNickname(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return { ok: false, reason: "اسم مستعار نمی‌تونه خالی باشه 🙂 یه اسم برای خودت بنویس." };
  }
  if (value.length > LETTERS.NICKNAME_MAX) {
    return { ok: false, reason: `اسم مستعار باید حداکثر ${LETTERS.NICKNAME_MAX} کاراکتر باشه. یه اسم کوتاه‌تر انتخاب کن.` };
  }
  if (/@\w/.test(value) || /https?:\/\//i.test(value) || /t\.me\//i.test(value)) {
    return { ok: false, reason: "اسم مستعار نباید شامل لینک یا آیدی باشه. یه اسم ساده بنویس 🙂" };
  }
  if (/\d{7,}/.test(value.replace(/\D/g, ""))) {
    return { ok: false, reason: "اسم مستعار نباید شماره تماس داشته باشه. یه اسم ساده بنویس 🙂" };
  }
  return { ok: true, value };
}

/** Validate a new-letter body: between 100 and 4096 chars. */
export function validateLetterBody(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = (raw ?? "").trim();
  if (value.length < LETTERS.BODY_MIN) {
    return {
      ok: false,
      reason: `نامه‌ات خیلی کوتاهه رفیق 💌\nبرای اینکه واقعاً شبیه نامه باشه، حداقل باید ${LETTERS.BODY_MIN} کاراکتر داشته باشه.`,
    };
  }
  if (value.length > LETTERS.BODY_MAX) {
    return { ok: false, reason: `نامه خیلی بلنده 😅 باید توی یک پیام تلگرام جا بشه (حداکثر ${LETTERS.BODY_MAX} کاراکتر).` };
  }
  return { ok: true, value };
}

/** Validate a reply body: no minimum, only the Telegram max. */
export function validateReplyBody(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return { ok: false, reason: "پاسخت خالیه 🙂 یه چیزی بنویس." };
  }
  if (value.length > LETTERS.BODY_MAX) {
    return { ok: false, reason: `پاسخ خیلی بلنده 😅 باید توی یک پیام تلگرام جا بشه (حداکثر ${LETTERS.BODY_MAX} کاراکتر).` };
  }
  return { ok: true, value };
}

// ────────────────────────────── settings / onboarding ────────────────────────

export async function getLetterUser(env: Env, userId: number): Promise<LetterUser | null> {
  return await queryOne<LetterUser>(env, "SELECT * FROM letter_users WHERE user_id = ?", [userId]);
}

export async function createLetterUser(env: Env, userId: number, nickname: string): Promise<void> {
  await execute(
    env,
    `INSERT INTO letter_users (user_id, nickname) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, updated_at = datetime('now')`,
    [userId, nickname]
  );
}

export async function updateNickname(env: Env, userId: number, nickname: string): Promise<void> {
  await execute(
    env,
    "UPDATE letter_users SET nickname = ?, updated_at = datetime('now') WHERE user_id = ?",
    [nickname, userId]
  );
}

export async function setNotifEnabled(env: Env, userId: number, enabled: boolean): Promise<void> {
  await execute(
    env,
    "UPDATE letter_users SET notif_enabled = ?, updated_at = datetime('now') WHERE user_id = ?",
    [enabled ? 1 : 0, userId]
  );
}

export async function disableReceiving(env: Env, userId: number): Promise<void> {
  await execute(
    env,
    "UPDATE letter_users SET receiving_disabled_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?",
    [userId]
  );
}

export async function enableReceiving(env: Env, userId: number): Promise<void> {
  await execute(
    env,
    "UPDATE letter_users SET receiving_disabled_at = NULL, updated_at = datetime('now') WHERE user_id = ?",
    [userId]
  );
}

// ────────────────────────────────── quota ────────────────────────────────────

/** Count NEW letters (not replies) the user has sent so far in the current Iran-day. */
export async function countNewLettersToday(env: Env, userId: number): Promise<number> {
  const row = await queryOne<{ c: number }>(
    env,
    `SELECT COUNT(*) AS c FROM letter_messages
     WHERE sender_user_id = ? AND is_reply = 0
       AND date(created_at, '${TIME_ZONE_OFFSET}') = date('now', '${TIME_ZONE_OFFSET}')`,
    [userId]
  );
  return row?.c ?? 0;
}

// ───────────────────────────── recipient selection ───────────────────────────

/**
 * Pick up to FANOUT eligible recipients for a new letter, prioritising those who
 * have received the fewest letters (ties broken randomly). Eligible = active
 * subscriber, not banned, receiving enabled, not blocked either way, not self.
 */
export async function pickRecipients(env: Env, senderId: number): Promise<EligibleRecipient[]> {
  return await queryAll<EligibleRecipient>(
    env,
    `SELECT u.id, u.telegram_id, lu.nickname, lu.notif_enabled,
            (SELECT COUNT(*) FROM letter_messages lm
               WHERE lm.recipient_user_id = u.id AND lm.is_reply = 0) AS received_count
     FROM users u
     JOIN letter_users lu ON lu.user_id = u.id
     WHERE u.is_approved = 1
       AND COALESCE(u.is_banned, 0) = 0
       AND u.id <> ?
       AND lu.receiving_disabled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM letter_blocks b
         WHERE (b.blocker_user_id = u.id AND b.blocked_user_id = ?)
            OR (b.blocker_user_id = ? AND b.blocked_user_id = u.id)
       )
     ORDER BY received_count ASC, RANDOM()
     LIMIT ?`,
    [senderId, senderId, senderId, LETTERS.FANOUT]
  );
}

// ─────────────────────────────── send / reply ────────────────────────────────

function lastRowId(result: D1Result): number {
  return (result.meta as unknown as { last_row_id?: number })?.last_row_id || 0;
}

/**
 * Create and fan out a new letter. Creates one thread + one message per eligible
 * recipient. Returns the deliveries (for notification). Empty array = nobody
 * eligible right now (caller should NOT consume the daily quota in that case).
 */
export async function sendNewLetter(
  env: Env,
  senderId: number,
  senderNickname: string,
  body: string
): Promise<LetterDelivery[]> {
  const recipients = await pickRecipients(env, senderId);
  const deliveries: LetterDelivery[] = [];

  for (const r of recipients) {
    const threadRes = await execute(
      env,
      "INSERT INTO letter_threads (user_a_id, user_b_id) VALUES (?, ?)",
      [senderId, r.id]
    );
    const threadId = lastRowId(threadRes);

    const msgRes = await execute(
      env,
      `INSERT INTO letter_messages
         (thread_id, sender_user_id, recipient_user_id, sender_nickname, body, is_reply, ref_message_id)
       VALUES (?, ?, ?, ?, ?, 0, NULL)`,
      [threadId, senderId, r.id, senderNickname, body]
    );
    const messageId = lastRowId(msgRes);

    deliveries.push({
      recipientUserId: r.id,
      telegramId: r.telegram_id,
      messageId,
      notifEnabled: r.notif_enabled === 1,
    });
  }

  return deliveries;
}

/**
 * Append a reply to the thread of the referenced message. The replier must be the
 * recipient of the referenced message. Returns the delivery for the other party,
 * or null if the reference is gone/not owned or the two users are blocked.
 */
export async function sendReply(
  env: Env,
  senderId: number,
  senderNickname: string,
  refMessageId: number,
  body: string
): Promise<LetterDelivery | null> {
  const ref = await queryOne<LetterMessage>(
    env,
    "SELECT * FROM letter_messages WHERE id = ? AND recipient_user_id = ?",
    [refMessageId, senderId]
  );
  if (!ref) return null;

  const otherId = ref.sender_user_id;
  if (await isBlockedEitherWay(env, senderId, otherId)) return null;

  const other = await queryOne<{ telegram_id: number; notif_enabled: number }>(
    env,
    `SELECT u.telegram_id, lu.notif_enabled
     FROM users u JOIN letter_users lu ON lu.user_id = u.id
     WHERE u.id = ?`,
    [otherId]
  );
  if (!other) return null;

  const msgRes = await execute(
    env,
    `INSERT INTO letter_messages
       (thread_id, sender_user_id, recipient_user_id, sender_nickname, body, is_reply, ref_message_id)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [ref.thread_id, senderId, otherId, senderNickname, body, refMessageId]
  );
  const messageId = lastRowId(msgRes);

  await execute(env, "UPDATE letter_messages SET replied_at = datetime('now') WHERE id = ?", [refMessageId]);
  await execute(env, "UPDATE letter_threads SET last_message_at = datetime('now') WHERE id = ?", [ref.thread_id]);

  return {
    recipientUserId: otherId,
    telegramId: other.telegram_id,
    messageId,
    notifEnabled: other.notif_enabled === 1,
  };
}

// ─────────────────────────────── inbox / open ────────────────────────────────

/**
 * Inbox items: unanswered original letters (within 7 days) and unanswered replies
 * (no time limit until 30-day purge), newest first.
 */
export async function getInbox(env: Env, userId: number): Promise<LetterMessage[]> {
  return await queryAll<LetterMessage>(
    env,
    `SELECT * FROM letter_messages
     WHERE recipient_user_id = ?
       AND replied_at IS NULL
       AND (is_reply = 1 OR created_at > datetime('now', '-${LETTERS.INBOX_EXPIRY_DAYS} days'))
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId]
  );
}

/** Count of unread inbox items (drives the inbox-button badge). */
export async function countUnread(env: Env, userId: number): Promise<number> {
  const row = await queryOne<{ c: number }>(
    env,
    `SELECT COUNT(*) AS c FROM letter_messages
     WHERE recipient_user_id = ?
       AND is_read = 0
       AND replied_at IS NULL
       AND (is_reply = 1 OR created_at > datetime('now', '-${LETTERS.INBOX_EXPIRY_DAYS} days'))`,
    [userId]
  );
  return row?.c ?? 0;
}

/** Fetch a message the given user received (ownership-checked). */
export async function getMessageForRecipient(
  env: Env,
  messageId: number,
  userId: number
): Promise<LetterMessage | null> {
  return await queryOne<LetterMessage>(
    env,
    "SELECT * FROM letter_messages WHERE id = ? AND recipient_user_id = ?",
    [messageId, userId]
  );
}

/** Fetch a message by id without an ownership check (used only to quote the
 *  recipient's OWN referenced message — never to display a third party's data). */
export async function getMessageById(env: Env, messageId: number): Promise<LetterMessage | null> {
  return await queryOne<LetterMessage>(env, "SELECT * FROM letter_messages WHERE id = ?", [messageId]);
}

export async function markRead(env: Env, messageId: number, userId: number): Promise<void> {
  await execute(
    env,
    "UPDATE letter_messages SET is_read = 1 WHERE id = ? AND recipient_user_id = ?",
    [messageId, userId]
  );
}

// ────────────────────────────────── blocks ───────────────────────────────────

export async function isBlockedEitherWay(env: Env, a: number, b: number): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    env,
    `SELECT 1 AS one FROM letter_blocks
     WHERE (blocker_user_id = ? AND blocked_user_id = ?)
        OR (blocker_user_id = ? AND blocked_user_id = ?)
     LIMIT 1`,
    [a, b, b, a]
  );
  return row != null;
}

export async function addBlock(env: Env, blockerId: number, blockedId: number): Promise<void> {
  await execute(
    env,
    "INSERT OR IGNORE INTO letter_blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)",
    [blockerId, blockedId]
  );
}

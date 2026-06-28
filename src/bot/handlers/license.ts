import { Env } from "../../types";
import { TelegramUser } from "../types";
import { sendMessage } from "../telegram-api";
import { getOrCreateUser, DbUser } from "../../db/users";
import { queryOne, execute } from "../../db/client";
import { toJalaliString } from "../../utils/jalali";

/**
 * Extract the license code from user text, stripping the /start prefix if present.
 * @param text - The raw message text from the user
 * @returns The cleaned license code string (may be empty if no code was provided)
 */
export function extractLicenseCode(text: string): string {
  let code = text.trim();
  if (code.startsWith("/start")) {
    code = code.replace("/start", "").trim();
  }
  return code;
}

/**
 * Attempt to redeem a license code for a user, marking it as used and approving the user.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record attempting to redeem the code
 * @param code - The license code string to validate and apply
 * @returns An object with ok (whether redemption succeeded) and expireMessage (expiration info string)
 */
export async function applyLicenseCode(
  env: Env,
  user: DbUser,
  code: string
): Promise<{ ok: boolean; expireMessage: string }> {
  const licenseInfo = await queryOne<{ expiration_days: number | null }>(
    env,
    `SELECT expiration_days FROM access_codes WHERE code = ? AND used_by_user_id IS NULL`,
    [code]
  );
  if (!licenseInfo) return { ok: false, expireMessage: "" };

  const now = new Date().toISOString();
  const result = await execute(
    env,
    `UPDATE access_codes SET used_by_user_id = ?, used_at = ? WHERE code = ? AND used_by_user_id IS NULL`,
    [user.id, now, code]
  );
  if (result.meta.changes === 0) return { ok: false, expireMessage: "" };

  let expireMessage = "";
  if (licenseInfo.expiration_days && licenseInfo.expiration_days > 0) {
    const expireDate = new Date(Date.now() + licenseInfo.expiration_days * 24 * 60 * 60 * 1000);
    expireMessage = `\n⏰ اعتبار لایسنس: ${licenseInfo.expiration_days} روز (تا ${toJalaliString(expireDate)})`;
  }

  await execute(env, `UPDATE users SET is_approved = 1 WHERE id = ?`, [user.id]);
  user.is_approved = 1;
  return { ok: true, expireMessage };
}

/**
 * Handle the license flow for a brand-new user (no existing DB record).
 * @param env - The worker environment containing the D1 database binding
 * @param chatId - The Telegram chat ID to send messages to
 * @param tgUser - The Telegram user object from the incoming message
 * @param text - The raw message text that may contain a license code
 * @returns Always returns true (message was handled)
 */
export async function handleNewUserLicenseFlow(
  env: Env,
  chatId: number,
  tgUser: TelegramUser,
  text: string
): Promise<boolean> {
  const inputCode = extractLicenseCode(text);
  if (!inputCode) {
    await sendMessage(env, chatId, "👋 سلام! به ربات خوش اومدی.\n\nاین یک ربات خصوصی است. لطفاً کد لایسنس (Access Code) خودتون رو ارسال کنید تا اکانت شما فعال شود.");
    return true;
  }

  const user = await getOrCreateUser(env, tgUser);
  const result = await applyLicenseCode(env, user, inputCode);
  if (result.ok) {
    await sendMessage(env, chatId, `✅ تبریک! لایسنس شما تایید شد.${result.expireMessage}\nحالا می‌تونی از ربات استفاده کنی. برای شروع روی /start بزن یا از منو استفاده کن.`);
  } else {
    await sendMessage(env, chatId, "⛔️ کد لایسنس نامعتبر است یا قبلاً استفاده شده.\nلطفاً کد صحیح را ارسال کنید.");
  }
  return true;
}

/**
 * Handle the license flow for an existing but unapproved user.
 * @param env - The worker environment containing the D1 database binding
 * @param chatId - The Telegram chat ID to send messages to
 * @param user - The existing but unapproved database user record
 * @param text - The raw message text that may contain a license code
 * @returns Always returns true (message was handled)
 */
export async function handleUnapprovedUserLicenseFlow(
  env: Env,
  chatId: number,
  user: DbUser,
  text: string
): Promise<boolean> {
  const inputCode = extractLicenseCode(text);
  if (!inputCode) {
    await sendMessage(env, chatId, "لطفاً کد لایسنس خود را ارسال کنید:");
    return true;
  }

  const result = await applyLicenseCode(env, user, inputCode);
  if (result.ok) {
    await sendMessage(env, chatId, `✅ اکانت شما فعال شد!${result.expireMessage}\nحالا می‌تونید از ربات استفاده کنید.`);
  } else {
    await sendMessage(env, chatId, "⛔️ کد وارد شده معتبر نیست. لطفاً کد صحیح را ارسال کنید.");
  }
  return true;
}

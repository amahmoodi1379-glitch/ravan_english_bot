import { Env } from "../../types";
import { TelegramUpdate } from "../types";
import { getSetting, setSetting } from "../../db/settings";
import { queryOne } from "../../db/client";
import { isAdmin } from "../../db/admin";
import { answerCallbackQuery, sendMessage } from "../telegram-api";
import { escapeHtml } from "../../utils/html";

/**
 * «حالت انتقال» — moving everyone to the Zabanyar web app (ravanenglish.ir).
 *
 * Off unless an admin turns it on (admin panel → 📦 خروجی زبان‌یار); until then
 * the bot runs exactly as before. While it is on:
 * - every update from a learner is answered with the move message, which carries
 *   that learner's own licence code (they sign in to Zabanyar with it), and
 *   nothing else runs, so nothing is recorded after the final export;
 * - the hourly jobs stop (index.ts): no tournament, league, reports or reminders;
 * - admins keep the whole bot, so they can still send the announcement
 *   (📢 اطلاع‌رسانی) and test.
 */

export const TRANSFER_MODE_KEY = "transfer_mode";
export const ZABANYAR_URL = "https://ravanenglish.ir";
export const ZABANYAR_APK_URL = "https://ravanenglish.ir/download/zabanyar.apk";

// The switch is read on every update; a short per-isolate cache keeps that off D1.
const CACHE_MS = 15_000;
let cached: { on: boolean; at: number } | null = null;

/** Whether transfer mode is on (unset = off). */
export async function isTransferMode(env: Env, now: number = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.on;
  const on = (await getSetting(env, TRANSFER_MODE_KEY)) === "on";
  cached = { on, at: now };
  return on;
}

export async function setTransferMode(env: Env, on: boolean): Promise<void> {
  await setSetting(env, TRANSFER_MODE_KEY, on ? "on" : "off");
  cached = { on, at: Date.now() };
}

/** Test seam: forget the cached switch. */
export function resetTransferModeCache(): void {
  cached = null;
}

/** The learner's most recently used licence code, which signs them in to Zabanyar. */
export async function licenceCodeFor(env: Env, telegramId: number): Promise<string | null> {
  const row = await queryOne<{ code: string }>(
    env,
    `SELECT ac.code FROM access_codes ac
     JOIN users u ON u.id = ac.used_by_user_id
     WHERE u.telegram_id = ?
     ORDER BY ac.used_at DESC
     LIMIT 1`,
    [telegramId]
  );
  return row?.code ?? null;
}

/** The reply every learner gets while transfer mode is on. */
export function transferMessage(code: string | null): string {
  const lines = [
    "🚚 <b>این ربات به اپ «زبان‌یار» منتقل شد!</b>",
    "",
    "همه‌ی امتیازها، زنجیره، واژه‌ها و مدال‌هات اونجا منتظرته. از این به بعد همه‌چیز توی زبان‌یاره و این ربات دیگه چیزی ثبت نمی‌کنه.",
    "",
  ];
  if (code) {
    lines.push("🔑 <b>کد ورودت به زبان‌یار</b> (روش بزن تا کپی بشه):", `<code>${escapeHtml(code)}</code>`, "");
  } else {
    lines.push("🔑 به این حساب کد لایسنسی وصل نیست. برای ورود به زبان‌یار، کدت رو از پشتیبانی پکیج آقای یاورزاده بگیر.", "");
  }
  lines.push(
    `🌐 <b>${ZABANYAR_URL.replace("https://", "")}</b>`,
    "📱 اندروید: اپ زبان‌یار رو از دکمه‌ی پایین نصب کن.",
    "",
    "⏳ زنجیره و لیگت تا ۱۰ روز منتظرت می‌مونه؛ زودتر بیا!"
  );
  return lines.join("\n");
}

export const TRANSFER_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🌐 ورود به زبان‌یار", url: ZABANYAR_URL }],
    [{ text: "📱 دانلود اپ اندروید", url: ZABANYAR_APK_URL }],
  ],
};

/** The announcement for «📢 اطلاع‌رسانی» on moving day (the auto-reply above then hands each person their code). */
export const TRANSFER_ANNOUNCEMENT = [
  "🚚 این ربات به اپ «زبان‌یار» منتقل شد!",
  "",
  "همه‌ی امتیازها، زنجیره، واژه‌ها و مدال‌هات اونجا منتظرته.",
  "",
  `🌐 ${ZABANYAR_URL.replace("https://", "")}`,
  "🔑 با همون کد لایسنسی که اینجا زدی وارد شو. کدت یادت نیست؟ یه پیام به همین ربات بده تا برات بفرستمش.",
  "📱 کاربرهای اندروید می‌تونن اپ زبان‌یار رو از همون سایت نصب کنن.",
  "",
  "⏳ زنجیره و لیگت تا ۱۰ روز منتظرت می‌مونه؛ زودتر بیا!",
].join("\n");

/**
 * Called first for every update. Returns true when transfer mode handled it
 * (the caller must then do nothing else), false to let the bot run as usual.
 */
export async function handleTransferUpdate(env: Env, update: TelegramUpdate): Promise<boolean> {
  if (!(await isTransferMode(env))) return false;
  const from = update.message?.from ?? update.callback_query?.from;
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (!from) return true;
  if (await isAdmin(env, from.id)) return false;
  if (update.callback_query) {
    await answerCallbackQuery(env, update.callback_query.id, undefined, false).catch(() => {});
  }
  if (chatId !== undefined) {
    await sendMessage(env, chatId, transferMessage(await licenceCodeFor(env, from.id)), {
      parse_mode: "HTML",
      reply_markup: TRANSFER_KEYBOARD,
      disable_web_page_preview: true,
    });
  }
  return true;
}

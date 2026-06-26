import { Env } from "../../types";
import { TelegramMessage } from "../types";
import { sendMessage } from "../telegram-api";
import { getEmojiMap, saveEmojiMap, normEmoji, KNOWN_EMOJIS } from "../premium-emojis";

const HELP_TEXT =
  "✨ <b>مدیریت اموجی پرمیوم</b>\n\n" +
  "هر اموجی رو که ثبت کنی، ربات اون رو <b>همه‌جا</b> به‌صورت خودکار متحرک می‌کنه — " +
  "هم داخل متن پیام‌ها، هم به‌عنوان آیکون دکمه‌های اینلاین.\n\n" +
  "<b>روش ثبت:</b>\n" +
  "یک پیام بفرست که با <code>/pe</code> شروع بشه و بعدش نسخه‌ی <b>پرمیوم (متحرک)</b> اموجی‌ها رو از کیبورد پرمیوم تلگرام بذاری:\n" +
  "<code>/pe</code> 🔥🧠🏆⭐🎉👑💪✨\n\n" +
  "ربات custom_emoji_id رو از پیام درمیاره و ذخیره می‌کنه. هر تعداد بخوای می‌تونی یک‌جا یا چندبار بفرستی.\n\n" +
  "<b>دستورات:</b>\n" +
  "• <code>/pe</code> — همین راهنما + وضعیت\n" +
  "• <code>/pe list</code> — لیست کامل اموجی‌های ربات و وضعیت هرکدوم\n" +
  "• <code>/pe del</code> 🔥 — حذف ثبت یک اموجی (اموجی معمولی بذار)\n" +
  "• <code>/pe reset</code> — پاک کردن همه";

/**
 * Handle the admin `/pe` command for registering premium custom emoji.
 * - `/pe` (no emoji): shows help + current registration status.
 * - `/pe list`: shows the full known-emoji list with per-emoji status.
 * - `/pe reset`: clears all registered premium emoji.
 * - `/pe del <emoji>`: removes the registration for the given base emoji(s).
 * - `/pe <premium emojis>`: reads custom_emoji_id from the message entities and
 *   stores a base-emoji → id mapping. The central send-time transform then makes
 *   those emoji animated everywhere (messages + inline buttons).
 * @param env - The worker environment containing the D1 database binding
 * @param message - The incoming Telegram message (must contain the entities)
 * @returns void
 */
export async function handlePremiumEmojiCommand(env: Env, message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text ?? "";
  const arg = text.replace(/^\/pe(@\w+)?/, "").trim();

  if (arg === "reset") {
    await saveEmojiMap(env, {});
    await sendMessage(env, chatId, "♻️ همه‌ی اموجی‌های پرمیوم پاک شدند. حالا اموجی‌های معمولی نمایش داده می‌شن.");
    return;
  }

  if (arg === "list") {
    await sendMessage(env, chatId, buildFullList());
    return;
  }

  // /pe del <emoji ...> — unregister specific base emoji (plain emoji, not premium).
  if (arg.startsWith("del")) {
    const rest = arg.slice(3).trim();
    const map = { ...getEmojiMap() };
    let removed = 0;
    // Match any registered key that appears in the rest of the message.
    for (const key of Object.keys(map)) {
      if (rest.includes(key)) {
        delete map[key];
        removed++;
      }
    }
    await saveEmojiMap(env, map);
    await sendMessage(env, chatId, `🗑 <b>${removed}</b> اموجی از حالت پرمیوم خارج شد.\n\n` + buildStatus());
    return;
  }

  // Extract custom_emoji entities (the premium emoji the admin just sent).
  const customs = (message.entities ?? []).filter(
    (e) => e.type === "custom_emoji" && e.custom_emoji_id
  );

  if (customs.length === 0) {
    await sendMessage(env, chatId, HELP_TEXT + "\n\n" + buildStatus());
    return;
  }

  // Merge new mappings. entity offset/length are UTF-16 code units, which is
  // exactly what String.prototype.substring uses — so this extracts the base
  // emoji that the premium emoji falls back to.
  const map = { ...getEmojiMap() };
  let added = 0;
  for (const e of customs) {
    const base = text.substring(e.offset, e.offset + e.length);
    if (base) {
      map[normEmoji(base)] = e.custom_emoji_id as string;
      added++;
    }
  }

  await saveEmojiMap(env, map);
  await sendMessage(
    env,
    chatId,
    `✅ <b>${added}</b> اموجی پرمیوم ثبت شد! حالا همه‌جای ربات متحرکن.\n\n` + buildStatus()
  );
}

/** Build a short summary of how many emoji are registered. */
function buildStatus(): string {
  const count = Object.keys(getEmojiMap()).length;
  const registered = registeredKnownEmojis();
  let s = `📊 درمجموع <b>${count}</b> اموجی پرمیوم ثبت شده.`;
  if (registered.length > 0) s += `\n✅ ${registered.join(" ")}`;
  s += `\n\nℹ️ برای دیدن لیست کامل اموجی‌های ربات: <code>/pe list</code>`;
  return s;
}

/** Build the full known-emoji list, marking each as registered or not. */
function buildFullList(): string {
  const map = getEmojiMap();
  const done: string[] = [];
  const todo: string[] = [];
  for (const e of KNOWN_EMOJIS) {
    if (map[normEmoji(e)]) done.push(e);
    else todo.push(e);
  }
  let s = `📋 <b>اموجی‌های ربات</b> (${done.length} از ${KNOWN_EMOJIS.length} پرمیوم)\n\n`;
  s += `✅ <b>پرمیوم‌شده:</b>\n${done.length ? done.join(" ") : "— هنوز هیچ‌کدوم —"}\n\n`;
  s += `⬜️ <b>هنوز معمولی:</b>\n${todo.join(" ")}\n\n`;
  s += `برای پرمیوم‌کردن هرکدوم، نسخه‌ی متحرکش رو با <code>/pe</code> بفرست.`;
  return s;
}

/** The KNOWN_EMOJIS that currently have a registered premium id. */
function registeredKnownEmojis(): string[] {
  const map = getEmojiMap();
  return KNOWN_EMOJIS.filter((e) => map[normEmoji(e)]);
}

import { Env } from "../../types";
import { TelegramMessage } from "../types";
import { sendMessage } from "../telegram-api";
import { getEmojiMap, saveEmojiMap } from "../premium-emojis";

/** Strip the variation selector so keys match how pe() looks them up. */
function norm(emoji: string): string {
  return emoji.replace(/️/g, "");
}

// The base emojis the bot actually renders via pe() — used for the status report.
const USED_EMOJIS = [
  "🔥", "🧠", "🏆", "⭐", "🎉", "👑", "💪", "✨", "✅",
  "⚡", "🚀", "📖", "📚", "📊", "👋", "👤", "✏️", "🌟",
];

const HELP_TEXT =
  "✨ <b>اموجی پرمیوم</b>\n\n" +
  "برای جذاب‌تر کردن ربات با اموجی‌های متحرک پرمیوم:\n\n" +
  "۱) کیبورد اموجی پرمیوم تلگرام رو باز کن\n" +
  "۲) یک پیام برای ربات بفرست که با <code>/pe</code> شروع بشه و بعدش نسخه‌ی پرمیوم این اموجی‌ها رو بذاری:\n\n" +
  USED_EMOJIS.join(" ") + "\n\n" +
  "مثال: <code>/pe 🔥🧠🏆⭐🎉</code> (با اموجی‌های پرمیوم)\n\n" +
  "ربات خودش شناسه‌ها رو ذخیره می‌کنه و از همون لحظه اموجی‌ها متحرک می‌شن. " +
  "هر تعداد که بفرستی ثبت می‌شه؛ بقیه رو می‌تونی بعداً تکمیل کنی.\n\n" +
  "برای پاک کردن همه: <code>/pe reset</code>";

/**
 * Handle the admin `/pe` command for registering premium custom emoji.
 * - `/pe` (no emoji): shows help + current registration status.
 * - `/pe reset`: clears all registered premium emoji.
 * - `/pe <premium emojis>`: reads custom_emoji_id from the message entities and
 *   stores a base-emoji → id mapping so pe() can render the animated versions.
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
      map[norm(base)] = e.custom_emoji_id as string;
      added++;
    }
  }

  await saveEmojiMap(env, map);
  await sendMessage(
    env,
    chatId,
    `✅ <b>${added}</b> اموجی پرمیوم ثبت شد!\n\n` + buildStatus()
  );
}

/** Build a status line showing which of the bot's emojis are registered. */
function buildStatus(): string {
  const map = getEmojiMap();
  const done: string[] = [];
  const missing: string[] = [];
  for (const e of USED_EMOJIS) {
    if (map[norm(e)]) done.push(e);
    else missing.push(e);
  }
  let s = `📊 وضعیت: <b>${done.length}</b> از <b>${USED_EMOJIS.length}</b> ثبت شده\n`;
  if (done.length > 0) s += `\n✅ ثبت‌شده: ${done.join(" ")}`;
  if (missing.length > 0) s += `\n⬜️ باقی‌مانده: ${missing.join(" ")}`;
  return s;
}

import { Env } from "../../types";
import { TelegramMessage } from "../types";
import { sendMessage } from "../telegram-api";
import { getEmojiMap, saveEmojiMap, normEmoji, KNOWN_EMOJIS } from "../premium-emojis";

const HELP_TEXT =
  "✨ <b>مدیریت اموجی پرمیوم</b>\n\n" +
  "هر اموجی رو که ثبت کنی، ربات اون رو <b>همه‌جا</b> خودکار متحرک می‌کنه — " +
  "هم داخل متن پیام‌ها، هم آیکون دکمه‌های اینلاین، هم منوی اصلی.\n\n" +
  "<b>روش ثبت (مبدا → مقصد):</b>\n" +
  "هر اموجیِ معمولیِ ربات رو بنویس و <b>بلافاصله</b> بعدش نسخه‌ی <b>پرمیوم (متحرک)</b> دلخواهت رو از کیبورد پرمیوم بذار:\n" +
  "<code>/pe</code> 🔥<i>«پرمیوم»</i> ⭐<i>«پرمیوم»</i>\n\n" +
  "یعنی «🔥 فعلی ربات رو با این اموجی متحرک جایگزین کن». هر تعداد جفت که بخوای پشت‌سرهم.\n\n" +
  "<i>نکته:</i> اموجیِ مبدا رو از روی لیست ربات بردار (<code>/pe list</code>) تا دقیقاً همونی که توی رباته جایگزین شه.\n\n" +
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

  // Parse the message into an ordered list of source (plain) emoji and target
  // (premium custom_emoji) tokens, then pair each source with the premium emoji
  // that follows it: "/pe 🔥<prem> ⭐<prem>" → 🔥→premium, ⭐→premium.
  const customs = (message.entities ?? [])
    .filter((e) => e.type === "custom_emoji" && e.custom_emoji_id)
    .sort((a, b) => a.offset - b.offset);

  if (customs.length === 0) {
    await sendMessage(env, chatId, HELP_TEXT + "\n\n" + buildStatus());
    return;
  }

  const map = { ...getEmojiMap() };
  let added = 0;
  let pendingSource: string | null = null;
  // Sticky regex matching one plain emoji cluster at the current position.
  const srcRe = /\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic}|️|\p{Emoji_Modifier})*/uy;

  let i = 0;
  while (i < text.length) {
    const cust = customs.find((e) => i >= e.offset && i < e.offset + e.length);
    if (cust) {
      // Target premium emoji: pair it with the most recent plain source emoji.
      // If none precedes it, fall back to its own base emoji (self-mapping).
      const fallback = text.substring(cust.offset, cust.offset + cust.length);
      const source = pendingSource ?? fallback;
      if (source) {
        map[normEmoji(source)] = cust.custom_emoji_id as string;
        added++;
      }
      pendingSource = null;
      i = cust.offset + cust.length;
      continue;
    }
    srcRe.lastIndex = i;
    const m = srcRe.exec(text);
    if (m && m.index === i) {
      pendingSource = m[0];
      i += m[0].length;
      continue;
    }
    i++;
  }

  await saveEmojiMap(env, map);
  await sendMessage(
    env,
    chatId,
    `✅ <b>${added}</b> جایگزینی ثبت شد! حالا همه‌جای ربات متحرکن.\n\n` + buildStatus()
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

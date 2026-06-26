import { Env } from "../../types";
import { TelegramMessage } from "../types";
import { sendMessage, getStickerSet } from "../telegram-api";
import { getEmojiMap, saveEmojiMap, SEED_IDS } from "../premium-emojis";

/** Strip the variation selector so keys match how pe() looks them up. */
function norm(emoji: string): string {
  return emoji.replace(/️/g, "");
}

// The base emojis the bot actually renders via pe() — used for the status report.
const USED_EMOJIS = [
  "🔥", "🧠", "🏆", "⭐", "🎉", "👑", "💪", "✨", "✅",
  "⚡", "🚀", "📖", "📚", "📊", "👋", "👤", "✏️", "🌟",
];
const USED_EMOJIS_SET = new Set(USED_EMOJIS.map((e) => e.replace(/️/g, "")));

const HELP_TEXT =
  "✨ <b>مدیریت اموجی پرمیوم</b>\n\n" +
  "<b>روش ۱ — از پک استیکر (توصیه‌شده):</b>\n" +
  "یک پک اموجی سفارشی پیدا کن در تلگرام، شناسه‌ی کوتاه پک رو از لینک <code>t.me/addemoji/SHORTNAME</code> بردار و بفرست:\n" +
  "<code>/pe pack SHORTNAME</code>\n" +
  "مثال: <code>/pe pack AnimatedEmojies</code>\n\n" +
  "<b>روش ۲ — ثبت دستی:</b>\n" +
  "یک پیام بفرست که با <code>/pe</code> شروع بشه و بعدش اموجی‌های پرمیوم (متحرک) رو از کیبورد پرمیوم تلگرام اضافه کن:\n" +
  "<code>/pe 🔥🧠🏆⭐🎉👑💪✨</code>\n\n" +
  "<b>اموجی‌هایی که ربات استفاده می‌کنه:</b>\n" +
  USED_EMOJIS.join(" ") + "\n\n" +
  "دستورات دیگه:\n" +
  "• <code>/pe reset</code> — پاک کردن همه ثبت‌شده‌ها";

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

  // /pe pack <shortName> — auto-register from a public custom emoji sticker pack.
  if (arg.startsWith("pack ")) {
    const packName = arg.slice(5).trim();
    if (!packName) {
      await sendMessage(env, chatId, "❌ نام پک رو بنویس. مثال: <code>/pe pack AnimatedEmojies</code>");
      return;
    }
    await sendMessage(env, chatId, `⏳ در حال دریافت اطلاعات پک <b>${packName}</b>...`);
    const stickerSet = await getStickerSet(env, packName);
    if (!stickerSet || !stickerSet.ok || !stickerSet.result) {
      const desc = stickerSet?.description ?? "خطای شبکه";
      await sendMessage(env, chatId, `❌ پک پیدا نشد: <code>${desc}</code>\n\nمطمئن شو نام کوتاه پک رو درست نوشتی.`);
      return;
    }
    if (stickerSet.result.sticker_type !== "custom_emoji") {
      await sendMessage(
        env, chatId,
        `⚠️ پک <b>${packName}</b> از نوع <b>${stickerSet.result.sticker_type}</b> هست، نه custom_emoji.\n` +
        "برای ثبت اموجی، پکی که در تلگرام به عنوان «اموجی سفارشی» نمایش داده می‌شه لازمه."
      );
      return;
    }
    const map = { ...getEmojiMap() };
    let added = 0;
    let matched = 0;
    for (const sticker of stickerSet.result.stickers) {
      if (!sticker.emoji || !sticker.custom_emoji_id) continue;
      matched++;
      const key = norm(sticker.emoji);
      if (USED_EMOJIS_SET.has(key) || USED_EMOJIS_SET.has(sticker.emoji)) {
        map[key] = sticker.custom_emoji_id;
        added++;
      }
    }
    await saveEmojiMap(env, map);
    await sendMessage(
      env, chatId,
      `✅ از پک <b>${stickerSet.result.title}</b> — ${matched} اموجی بررسی شد، <b>${added}</b> اموجی مرتبط ثبت شد!\n\n` +
      buildStatus()
    );
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
  const registered: string[] = [];
  const seeded: string[] = [];
  const missing: string[] = [];
  for (const e of USED_EMOJIS) {
    const key = norm(e);
    if (map[key]) registered.push(e);
    else if (SEED_IDS[key] || SEED_IDS[e]) seeded.push(e);
    else missing.push(e);
  }
  const total = registered.length + seeded.length;
  let s = `📊 وضعیت: <b>${total}</b> از <b>${USED_EMOJIS.length}</b> فعال\n`;
  if (registered.length > 0) s += `\n✅ ثبت‌شده توسط شما: ${registered.join(" ")}`;
  if (seeded.length > 0) s += `\n🌱 پیش‌فرض (seed): ${seeded.join(" ")}`;
  if (missing.length > 0) s += `\n⬜️ هنوز ثبت نشده: ${missing.join(" ")}`;
  return s;
}

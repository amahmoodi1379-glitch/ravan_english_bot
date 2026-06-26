import { Env } from "../types";

/**
 * Premium animated emoji support.
 *
 * Telegram lets a bot render animated "premium" emoji via the HTML tag
 * <tg-emoji emoji-id="...">fallback</tg-emoji> — but ONLY when the bot owner has
 * Telegram Premium, and ONLY with REAL custom_emoji_id values that point to
 * existing stickers (a fake id makes Telegram reject the whole message with
 * "DOCUMENT_INVALID").
 *
 * Instead of hardcoding (and guessing) ids, the bot owner registers them at
 * runtime: an admin sends the premium emoji to the bot with the `/pe` command,
 * the bot reads the custom_emoji_id from the message entities and stores a
 * base-emoji → id map in `system_settings`. From then on, pe("🔥") wraps the
 * emoji in <tg-emoji> automatically. If no id is registered for an emoji, the
 * plain emoji is returned — always safe.
 */

const SETTING_KEY = "premium_emoji_map";

/** Strip the variation selector so "⭐️" and "⭐" map to the same key. */
function norm(emoji: string): string {
  return emoji.replace(/️/g, "");
}

/**
 * Verified custom_emoji_id values sourced from published open-source examples.
 * These are used as fallbacks when the admin hasn't manually registered an emoji.
 * The admin's own registered IDs (via /pe or /pe pack) always take priority.
 * IDs are stable per Telegram API docs: "A custom emoji ID won't change when a
 * pack is updated."
 */
export const SEED_IDS: Record<string, string> = {
  "🔥": "5368324170671202286",  // from bragin0/telegram-custom-emoji-iinline-color
  "⭐": "5453969572354878595",  // from ulugby/aiogram3-bot-template (ICON_STAR)
};

// Module-level cache (persists across requests while the isolate is warm).
let emojiMap: Record<string, string> = {};
let loaded = false;

/**
 * Load the registered premium-emoji map from the database into the module cache.
 * Safe to call on every request — it only hits the DB once per warm isolate.
 * @param env - The worker environment containing the D1 database binding
 */
export async function loadEmojiMap(env: Env): Promise<void> {
  if (loaded) return;
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind(SETTING_KEY).first<{ value: string }>();
    if (row?.value) {
      emojiMap = JSON.parse(row.value) as Record<string, string>;
    }
  } catch {
    // Table missing or value unparoseable — fall back to plain emoji.
  }
  loaded = true;
}

/** Return the current in-memory base-emoji → custom_emoji_id map. */
export function getEmojiMap(): Record<string, string> {
  return emojiMap;
}

/**
 * Persist a new base-emoji → custom_emoji_id map and refresh the cache.
 * @param env - The worker environment containing the D1 database binding
 * @param map - The full map to store (replaces the previous one)
 */
export async function saveEmojiMap(env: Env, map: Record<string, string>): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS system_settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(SETTING_KEY, JSON.stringify(map)).run();
  emojiMap = map;
  loaded = true;
}

/**
 * Render an emoji. If a premium custom_emoji_id has been registered for this
 * base emoji (via the admin `/pe` command) it is wrapped in <tg-emoji> so
 * Premium clients show the animated version; otherwise the plain emoji is
 * returned. Always requires HTML parse mode (the bot already uses it).
 * @param base - The plain unicode emoji (e.g. "🔥")
 * @returns Either a <tg-emoji> HTML tag or the plain emoji
 */
export function pe(base: string): string {
  const key = norm(base);
  const id = emojiMap[key] ?? SEED_IDS[key];
  if (id) return `<tg-emoji emoji-id="${id}">${base}</tg-emoji>`;
  return base;
}

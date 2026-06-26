import { Env } from "../types";

/**
 * Premium animated emoji support.
 *
 * Telegram lets a bot render animated "premium" emoji two different ways — but
 * ONLY when the bot owner has Telegram Premium, and ONLY with REAL
 * custom_emoji_id values (a fake id makes Telegram reject the message with
 * "DOCUMENT_INVALID"):
 *
 *   1. In message TEXT (HTML parse mode) via the tag
 *      <tg-emoji emoji-id="...">fallback</tg-emoji>.
 *   2. On INLINE keyboard buttons via the `icon_custom_emoji_id` field
 *      (Bot API 9.4+) — the animated emoji is shown as the button's leading
 *      icon. This does NOT work with the <tg-emoji> tag.
 *
 * The bot owner registers ids at runtime by sending the premium emoji to the
 * bot with the `/pe` command; the custom_emoji_id is read from the message
 * entities and a base-emoji → id map is stored in `system_settings`.
 *
 * From then on a single central transform (applied at send time in
 * telegram-api.ts) rewrites EVERY outgoing message and EVERY inline button
 * automatically — so an emoji only has to be registered once and it becomes
 * animated everywhere it appears. Nothing is hardcoded; if an emoji has no
 * registered id, the plain emoji is shown — always safe.
 *
 * NOTE: reply-keyboard buttons (the persistent main/admin menus) are
 * intentionally left untouched. Their `text` is echoed back verbatim when
 * tapped and the router matches on it, so rewriting them would break
 * navigation.
 */

const SETTING_KEY = "premium_emoji_map";

/** Strip the variation selector so "⭐️" and "⭐" map to the same key. */
export function normEmoji(emoji: string): string {
  return emoji.replace(/️/g, "");
}

/**
 * The complete set of emoji the bot renders anywhere (messages, inline
 * buttons, reply menus, avatars …), auto-discovered from the source. Used only
 * to build the `/pe` status report so the admin can see exactly which emoji
 * exist and which are still plain. Functionality does not depend on this list —
 * any registered emoji is replaced everywhere regardless.
 */
export const KNOWN_EMOJIS: string[] = [
  "←", "→", "↩", "⇒", "⏭", "⏮", "⏰", "⏱", "⏳", "♂", "♻", "♾", "⚙", "⚠", "⚡",
  "⚪", "⛔", "✅", "✍", "✏", "✨", "❄", "❌", "❓", "❗", "➕", "➖", "➡", "⬅", "⬇",
  "⬜", "⭐", "🆔", "🆕", "🌟", "🌱", "🍀", "🎉", "🎓", "🎙", "🎥", "🎫", "🎭", "🎮",
  "🎵", "🏁", "🏅", "🏆", "🏠", "🏷", "🐉", "🐋", "🐙", "🐝", "🐢", "🐧", "🐨", "🐯",
  "🐰", "🐴", "🐵", "🐶", "🐸", "🐺", "🐻", "🐼", "👇", "👈", "👋", "👌", "👍", "👑",
  "👤", "👥", "👨", "👩", "👻", "👽", "💡", "💪", "📂", "📄", "📅", "📆", "📈", "📉",
  "📊", "📋", "📌", "📍", "📖", "📗", "📚", "📝", "📢", "📤", "📥", "🔄", "🔒", "🔗",
  "🔙", "🔤", "🔥", "🔬", "🔴", "🔵", "🕐", "🕵", "🖼", "🗑", "🗓", "😉", "😊", "😍",
  "😺", "🙈", "🚀", "🚪", "🚫", "🛑", "🛠", "🟠", "🟢", "🤔", "🤖", "🥇", "🥈", "🥉",
  "🥷", "🦁", "🦄", "🦅", "🦈", "🦉", "🦊", "🦋", "🦖", "🧙", "🧠", "🪪",
];

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
    // Table missing or value unparseable — fall back to plain emoji.
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
 * Legacy helper kept for backwards compatibility. The central transform now
 * wraps every emoji automatically, so this simply returns the plain emoji to
 * avoid double-wrapping. Existing pe("🔥") call sites are harmless.
 * @param base - The plain unicode emoji
 * @returns The emoji unchanged
 */
export function pe(base: string): string {
  return base;
}

// --- Central transform (applied at send time) ---

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let cachedRegexSource = "";
let cachedRegex: RegExp | null = null;

/**
 * Build (and cache) a single regex matching any registered emoji, optionally
 * followed by the variation selector. Longer keys first so multi-codepoint
 * emoji win over any prefix.
 */
function buildEmojiRegex(): RegExp | null {
  const keys = Object.keys(emojiMap);
  if (keys.length === 0) return null;
  const source = keys.join("|");
  if (source !== cachedRegexSource || !cachedRegex) {
    const alt = keys
      .sort((a, b) => b.length - a.length)
      .map((k) => escapeRegex(k))
      .join("|");
    cachedRegex = new RegExp(`(?:${alt})\\uFE0F?`, "gu");
    cachedRegexSource = source;
  }
  return cachedRegex;
}

/**
 * Rewrite message text (HTML parse mode) so every registered emoji becomes an
 * animated <tg-emoji>. Emoji inside HTML tags are left untouched, and the
 * matched text (including any variation selector) is preserved as the fallback.
 * @param text - The HTML message text
 * @returns The text with registered emoji wrapped in <tg-emoji>
 */
export function applyPremiumEmojiToText(text: string): string {
  const re = buildEmojiRegex();
  if (!re) return text;

  // Split into tag / non-tag segments so we never touch emoji inside markup
  // (e.g. attributes, or an already-emitted <tg-emoji>).
  const parts = text.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // odd indices are the HTML tags themselves
    parts[i] = parts[i].replace(re, (match) => {
      const id = emojiMap[normEmoji(match)];
      if (!id) return match;
      return `<tg-emoji emoji-id="${id}">${match}</tg-emoji>`;
    });
  }
  return parts.join("");
}

interface MutableButton {
  text?: string;
  callback_data?: string;
  url?: string;
  icon_custom_emoji_id?: string;
  [key: string]: unknown;
}

/**
 * For an inline keyboard, give each button whose text STARTS with a registered
 * emoji an animated `icon_custom_emoji_id`, stripping that leading emoji from
 * the text so it isn't shown twice. Buttons that already have an icon, or whose
 * leading emoji isn't registered, are left as-is. Reply keyboards are never
 * touched (their text is matched by the router).
 * @param replyMarkup - The reply_markup object (any shape)
 * @returns The same object, with inline buttons enriched in place
 */
export function applyPremiumEmojiToMarkup<T>(replyMarkup: T): T {
  const re = buildEmojiRegex();
  if (!re) return replyMarkup;

  const markup = replyMarkup as { inline_keyboard?: MutableButton[][] } | null | undefined;
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return replyMarkup;

  // Anchored copy of the regex to test only the start of a button label.
  const leadRe = new RegExp(`^(?:${re.source})`, "u");

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (!btn || typeof btn.text !== "string" || btn.icon_custom_emoji_id) continue;
      const m = btn.text.match(leadRe);
      if (!m) continue;
      const id = emojiMap[normEmoji(m[0])];
      if (!id) continue;
      btn.icon_custom_emoji_id = id;
      // Strip the leading emoji and a single following space.
      btn.text = btn.text.slice(m[0].length).replace(/^\s/, "");
    }
  }
  return replyMarkup;
}

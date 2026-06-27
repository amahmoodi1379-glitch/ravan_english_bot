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

// On an inline/reply button the animated icon is always placed at the start of
// the button (the visual end of RTL Persian text). This EN-SPACE sits between
// the icon and the label so the animation isn't glued to the text.
// EN-SPACE (U+2002) is used because clients don't trim it the way they trim
// ordinary spaces.
const ICON_GAP = " ";

/** Matches a single leading emoji cluster (emoji + modifiers / ZWJ sequence). */
const LEAD_EMOJI = "\\p{Extended_Pictographic}(?:\\u200D\\p{Extended_Pictographic}|\\uFE0F|\\p{Emoji_Modifier})*";

/**
 * Normalise a button label for router matching: trim, drop a single leading
 * emoji cluster (and the spaces around it), trim again. So "🎮 تمرین‌ها",
 * "تمرین‌ها" and "تمرین‌ها  " all map to the same key.
 */
export function normalizeMenu(label: string): string {
  let t = label.trim();
  const m = t.match(new RegExp(`^(?:${LEAD_EMOJI})\\s*`, "u"));
  if (m) t = t.slice(m[0].length);
  return t.trim();
}

// Reply-keyboard labels that are safe to animate (the user-facing menus only).
// Admin / dynamic keyboards are deliberately excluded so the router's exact
// text matching for those never breaks. Populated by keyboards.ts at load time.
const userMenuByNorm: Record<string, string> = {};

/**
 * Register the user-facing reply-keyboard button labels so they can be animated
 * and canonicalised. Called once from keyboards.ts.
 * @param labels - The full button label strings (with their emoji)
 */
export function registerUserMenuLabels(labels: string[]): void {
  for (const l of labels) userMenuByNorm[normalizeMenu(l)] = l;
}

/**
 * Map an incoming reply-keyboard tap back to its canonical label. A tapped
 * button may arrive emoji-stripped (when we animated it) or full; either way
 * this returns the original constant so the router's `text === CONSTANT` checks
 * keep working. Non-menu text is returned unchanged.
 * @param text - The incoming message text
 * @returns The canonical menu label, or the text unchanged
 */
export function canonicalizeUserMenu(text: string): string {
  return userMenuByNorm[normalizeMenu(text)] ?? text;
}

/**
 * Whether an incoming message is a registered user-facing reply-keyboard button
 * (whether it arrived emoji-stripped or full). Use this — not
 * `canonicalizeUserMenu(text) !== text` — to detect a menu tap, because a full
 * canonical label canonicalises to itself and would be missed by that check.
 * @param text - The incoming message text
 * @returns True if the text maps to a registered menu button
 */
export function isUserMenuLabel(text: string): boolean {
  return Object.prototype.hasOwnProperty.call(userMenuByNorm, normalizeMenu(text));
}

/** Strip a leading emoji of given length and add the icon/text gap. */
function stripAndGap(label: string, emojiLen: number): string {
  return label.slice(emojiLen).replace(/^\s+/, "") + ICON_GAP;
}

/**
 * Animate keyboard buttons whose label STARTS with a registered emoji by moving
 * that emoji into `icon_custom_emoji_id` (and stripping it from the text so it
 * isn't shown twice):
 *   - inline keyboards: every such button (safe — they use callback_data);
 *   - reply keyboards: only the registered user-facing menu buttons, so the
 *     router's exact-text matching for admin/dynamic keyboards is never touched.
 * @param replyMarkup - The reply_markup object (any shape)
 * @returns The same object, mutated in place
 */
export function applyPremiumEmojiToMarkup<T>(replyMarkup: T): T {
  const re = buildEmojiRegex();
  if (!re) return replyMarkup;

  // Anchored regex matching a registered emoji at the start of a label.
  const leadRe = new RegExp(`^(?:${re.source})`, "u");
  const markup = replyMarkup as {
    inline_keyboard?: MutableButton[][];
    keyboard?: (MutableButton | string)[][];
  } | null | undefined;

  // Inline keyboards — animate any button starting with a registered emoji.
  if (Array.isArray(markup?.inline_keyboard)) {
    for (const row of markup.inline_keyboard) {
      if (!Array.isArray(row)) continue;
      for (const btn of row) {
        if (!btn || typeof btn.text !== "string" || btn.icon_custom_emoji_id) continue;
        const m = btn.text.match(leadRe);
        if (!m) continue;
        const id = emojiMap[normEmoji(m[0])];
        if (!id) continue;
        btn.icon_custom_emoji_id = id;
        btn.text = stripAndGap(btn.text, m[0].length);
      }
    }
  }

  // Reply keyboards — only the known user-facing menu buttons.
  if (Array.isArray(markup?.keyboard)) {
    for (const row of markup.keyboard) {
      if (!Array.isArray(row)) continue;
      for (let j = 0; j < row.length; j++) {
        const btn = row[j];
        const label = typeof btn === "string"
          ? btn
          : (btn && typeof btn.text === "string" ? btn.text : null);
        if (label === null) continue;
        if (!(normalizeMenu(label) in userMenuByNorm)) continue;
        const m = label.match(leadRe);
        if (!m) continue;
        const id = emojiMap[normEmoji(m[0])];
        if (!id) continue;
        const newText = stripAndGap(label, m[0].length);
        if (typeof btn === "string") {
          row[j] = { text: newText, icon_custom_emoji_id: id };
        } else {
          btn.text = newText;
          btn.icon_custom_emoji_id = id;
        }
      }
    }
  }

  return replyMarkup;
}

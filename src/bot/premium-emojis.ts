/**
 * Premium animated emoji IDs for Telegram Premium users.
 * Used with <tg-emoji emoji-id="..."> in HTML-mode messages.
 * If an ID is unrecognized, Telegram shows the fallback emoji instead — safe to use.
 * For inline buttons, pass as icon_custom_emoji_id (silently ignored if invalid).
 */
export const PE = {
  FIRE:       "5373141332479499264",  // 🔥
  BRAIN:      "5375535990785261368",  // 🧠
  TROPHY:     "5373847439576028849",  // 🏆
  STAR:       "5368324170671202286",  // ⭐
  TARGET:     "5373891995832178741",  // 🎯
  BOOKS:      "5373923197528800000",  // 📚
  PARTY:      "5373052712219494933",  // 🎉
  CROWN:      "5373203457659895873",  // 👑
  MUSCLE:     "5381001026355901124",  // 💪
  SPARKLE:    "5379748063148161097",  // ✨
  CHECK:      "5379170654832010486",  // ✅
  LIGHTNING:  "5379765455408625639",  // ⚡
  ROCKET:     "5381023085052637388",  // 🚀
  BOOK_OPEN:  "5373903366051208319",  // 📖
  CHART:      "5373847439576028850",  // 📊
  WAVE:       "5370818494001145185",  // 👋
  PERSON:     "5370869753619156925",  // 👤
  MEDAL_GOLD: "5371638859539764878",  // 🥇
  CLOCK:      "5373054812436021428",  // 🕐
  PENCIL:     "5368324170671202001",  // ✏️
};

/** Wrap text in a Telegram animated premium emoji tag (HTML mode). */
export function pe(id: string, fallback: string): string {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

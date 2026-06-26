/**
 * Premium animated emoji IDs for Telegram Premium users.
 * To enable animated emoji: replace the IDs below with real ones from your emoji packs,
 * then change pe() to return the <tg-emoji> wrapper instead of just the fallback.
 *
 * How to get real IDs:
 *   1. Open @stickers bot in Telegram
 *   2. Forward any custom emoji to @getidsbot
 *   3. Copy the file_id (that's the custom_emoji_id)
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

/**
 * Returns a fallback emoji for now. Once you have verified custom emoji IDs,
 * change this to: return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
 */
export function pe(_id: string, fallback: string): string {
  return fallback;
}

// مقادیر امتیاز (XP)
export const XP_VALUES = {
  LEITNER_LEVEL_1: 5,
  LEITNER_LEVEL_2: 8,
  LEITNER_LEVEL_3: 12,
  LEITNER_LEVEL_4: 16,
  
  READING_QUESTION: 15,
  READING_BONUS_PERFECT: 10, // 3 از 3
  READING_BONUS_GOOD: 5,     // 2 از 3
  
  DUEL_QUESTION: 10,
  DUEL_WIN_BONUS: 30,
  DUEL_DRAW_BONUS: 10,
};

// تنظیمات بازی
export const GAME_CONFIG = {
  DUEL_QUESTION_COUNT: 5,
  READING_QUESTION_COUNT: 3,
};

// پیشوندهای کوتاه برای Callback Data (جهت رعایت محدودیت ۶۴ بایت تلگرام)
export const CB_PREFIX = {
  LEITNER: "l",         // قبلاً: leitner
  LEITNER_IGNORE: "lig",// قبلاً: leitner:ignore (بدون : برای صرفه‌جویی)
  READING_TEXT: "rt",   // قبلاً: reading:text
  READING_ANSWER: "ra", // قبلاً: reading:ans
  DUEL: "d",            // قبلاً: duel
  LEADERBOARD: "lb",    // قبلاً: lb
  AVATAR: "av",         // قبلاً: avatar
  STATS: "st",          // قبلاً: stats
};

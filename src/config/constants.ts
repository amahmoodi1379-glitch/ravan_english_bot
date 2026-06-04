// مقادیر امتیاز (XP)
export const XP_VALUES = {
  LEITNER_LEVEL_1: 5,
  LEITNER_LEVEL_2: 8,
  LEITNER_LEVEL_3: 12,
  LEITNER_LEVEL_4: 16,
  
  READING_QUESTION: 15,
  READING_BONUS_PERFECT: 10, // 3 از 3
  READING_BONUS_GOOD: 5,     // 2 از 3
};

// تنظیمات بازی
export const GAME_CONFIG = {
  READING_QUESTION_COUNT: 3,
};

// پیشوندهای کوتاه برای Callback Data (جهت رعایت محدودیت ۶۴ بایت تلگرام)
export const CB_PREFIX = {
  LEITNER: "l",         // قبلاً: leitner
  LEITNER_IGNORE: "lig",// قبلاً: leitner:ignore (بدون : برای صرفه‌جویی)
  READING_TEXT: "rt",   // قبلاً: reading:text
  READING_ANSWER: "ra", // قبلاً: reading:ans
  AVATAR: "av",         // قبلاً: avatar
  STATS: "st",          // قبلاً: stats
  LEADERBOARD: "lb",    // leaderboard
  QUIZ: "qz",           // custom quiz
};

// تنظیم اختلاف ساعت ایران (یا هر منطقه زمانی دلخواه)
// چون ایران ساعت تابستانی ندارد، همیشه +3.5 است.
export const TIME_ZONE_OFFSET = '+3.5 hours';

export const LEITNER_TEST_TYPES = {
  EN_TO_FA: "en_to_fa",
  FA_TO_EN: "fa_to_en",
  DEFINITION_TO_WORD: "definition_to_word",
  WORD_TO_DEFINITION: "word_to_definition",
  CLOZE: "cloze",
} as const;

export type LeitnerTestType = typeof LEITNER_TEST_TYPES[keyof typeof LEITNER_TEST_TYPES];

export const LEITNER_TEST_TYPE_ORDER: LeitnerTestType[] = [
  LEITNER_TEST_TYPES.EN_TO_FA,
  LEITNER_TEST_TYPES.FA_TO_EN,
  LEITNER_TEST_TYPES.DEFINITION_TO_WORD,
  LEITNER_TEST_TYPES.WORD_TO_DEFINITION,
  LEITNER_TEST_TYPES.CLOZE,
];

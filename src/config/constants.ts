export const XP_VALUES = {
  LEITNER_LEVEL_1: 5,
  LEITNER_LEVEL_2: 8,
  LEITNER_LEVEL_3: 12,
  LEITNER_LEVEL_4: 16,
  LEITNER_WRONG: 1,   // جواب غلط (Hard / Again)
  LEITNER_DUNNO: 1,   // نمیدونم

  READING_QUESTION: 15,
  READING_BONUS_PERFECT: 10,
  READING_BONUS_GOOD: 5,
};

export const GAME_CONFIG = {
  READING_QUESTION_COUNT: 3,
};

export const CB_PREFIX = {
  LEITNER: "l",
  LEITNER_IGNORE: "lig",
  LEITNER_IGNORE_CONFIRM: "ligc",
  LEITNER_RATE: "lr",
  LEITNER_NEXT: "lnx",
  LEITNER_EXIT: "lex",
  LEITNER_EXIT_CONFIRM: "lexc",
  LEITNER_DUNNO: "ldn",
  LEITNER_HOME: "lhm",
  LEITNER_UNLEECH: "lul",
  LEITNER_NEW_LEVEL: "lnl",
  LEITNER_REVIEW_LEVEL: "lrl",
  LEITNER_REPORT: "lrp",
  LEITNER_REPORT_CONFIRM: "lrpc",
  LEITNER_REPORT_CANCEL: "lrpx",
  READING_TEXT: "rt",
  READING_ANSWER: "ra",
  AVATAR: "av",
  STATS: "st",
  LEADERBOARD: "lb",
  QUIZ: "qz",
  LEITNER_LESSON_PICK: "llp",
  LEITNER_LESSON_CONT: "llc",
  LEITNER_LESSON_STOP: "lls",
  JOIN_CHECK: "jck",
  REMINDER_OPEN: "rmo",
};

export const LESSON_PICKER_PAGE_SIZE = 20;

/** Required channel the user must join to use the bot (force-join). */
export const REQUIRED_CHANNEL = "@psynex";

/** Minimum number of recorded answers before showing the "others answered" stats line. */
export const ANSWER_STATS_MIN_THRESHOLD = 5;

/** Days of inactivity at which each return-reminder stage fires (subscribers only). */
export const INACTIVITY_REMINDER_DAYS = [2, 5, 10] as const;

export const LEITNER_LEECH_THRESHOLD = 4;

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

/** Hours after which an active reading session is considered stale and auto-cancelled. */
export const STALE_SESSION_HOURS = 2;

/** Admin session TTL in milliseconds (24 hours). */
export const ADMIN_SESSION_TTL_MS = 86400 * 1000;

/** Admin session TTL in seconds (used for cookie Max-Age). */
export const ADMIN_SESSION_TTL_SECONDS = 86400;

/** Maximum attempts to pick a leitner question before giving up. */
export const QUESTION_PICK_MAX_ATTEMPTS = 15;

/** Number of items per page in admin list views. */
export const ADMIN_LIST_PAGE_SIZE = 50;

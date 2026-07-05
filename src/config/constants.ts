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

  // Daily tournament (0033): awarded once, at settlement. Flows through
  // activity_log so it also counts toward the weekly league (integrated scoring).
  TOURNAMENT_PARTICIPATE: 5,   // for anyone who finished/auto-ended an attempt
  TOURNAMENT_CORRECT: 6,       // per correct answer
};

export const GAME_CONFIG = {
  READING_QUESTION_COUNT: 3,
};

/**
 * Daily tournament configuration. The tournament is a time-windowed quiz opened
 * once a night and settled at close. OPEN_HOUR is expected to match the daily
 * progress-report hour (21) so its call-to-action can piggyback on that report
 * instead of a second 500-user broadcast.
 */
export const TOURNAMENT_CONFIG = {
  OPEN_HOUR: 21,             // Iran-local hour the tournament opens (matches daily report)
  CLOSE_HOUR: 22,            // Iran-local hour it closes AND settles
  QUESTION_COUNT: 10,        // number of questions auto-picked from word_questions
  DURATION_MINUTES: 10,      // per-user time limit once started (capped by CLOSE_HOUR)
  // Latest a NEW attempt may START, as minutes after OPEN_HOUR. Separating the
  // join window from the play duration guarantees a late joiner still gets the
  // full DURATION before settlement — nobody is cut off mid-attempt.
  // INVARIANT: JOIN_WINDOW_MINUTES + DURATION_MINUTES <= (CLOSE_HOUR-OPEN_HOUR)*60.
  JOIN_WINDOW_MINUTES: 45,   // 45 + 10 = 55 <= 60 → 5-min margin before the 22:00 tick
  RANK_BONUS_XP: [50, 30, 20], // extra XP for 1st / 2nd / 3rd at settlement
} as const;

/**
 * Weekly league configuration. Tiers ascend from index 0 (lowest). The week is
 * the Iran calendar week (Saturday → Friday); settlement runs Saturday 00:00 and
 * results are announced at ANNOUNCE_HOUR the same morning.
 */
export const LEAGUE_CONFIG = {
  ANNOUNCE_HOUR: 11,         // Iran-local Saturday hour to announce (11, not 10, to avoid stacking with 10:00 inactivity reminders)
  DIVISION_SIZE: 30,         // max users per division
  PROMOTE_COUNT: 7,          // top N of each division promote to the next tier
  DEMOTE_COUNT: 7,           // bottom N (with XP > 0) demote to the previous tier
  TIERS: ["برنز", "نقره", "طلا", "یاقوت", "الماس"], // tier 1..5 display names
} as const;

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
  TOURNAMENT: "tn",
  LEAGUE: "lg",
  LEITNER_LESSON_PICK: "llp",
  LEITNER_LESSON_CONT: "llc",
  LEITNER_LESSON_STOP: "lls",
  JOIN_CHECK: "jck",
  REMINDER_OPEN: "rmo",
  LETTERS_HOME: "lt",
  LETTER_INBOX: "lti",
  LETTER_OPEN: "lto",
  LETTER_REPLY: "ltr",
  LETTER_BLOCK: "ltb",
  LETTER_BLOCK_CONFIRM: "ltbc",
  LETTER_SETTINGS: "lts",
  LETTER_NOTIF_TOGGLE: "ltnt",
  LETTER_DISABLE: "ltd",
  LETTER_OPEN_PROACTIVE: "ltp",
};

/** Letters (نامه‌ها) feature limits and retention windows. */
export const LETTERS = {
  NICKNAME_MAX: 32,
  BODY_MIN: 100,
  BODY_MAX: 4096,
  DAILY_NEW_LIMIT: 2,
  FANOUT: 5,
  INBOX_EXPIRY_DAYS: 7,
  RETENTION_DAYS: 30,
  DISABLE_LOCK_DAYS: 7,
  QUOTE_CHARS: 80,
} as const;

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

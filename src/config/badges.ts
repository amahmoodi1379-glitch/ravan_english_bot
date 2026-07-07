/**
 * Medal / badge catalog (0034). Honorary achievements — no XP, no effect on the
 * league or leaderboards. The catalog lives here in code; only awarded rows are
 * stored in `user_badges`. Awarding is idempotent (UNIQUE + INSERT OR IGNORE).
 *
 * Two kinds:
 *  - Threshold badges (streak / xp / words / reading): auto-evaluated from a
 *    single numeric metric against a threshold (see evaluateThresholdBadges).
 *  - Event badges (tournament / league): awarded at their event (settlement).
 */

export type BadgeCategory = "streak" | "xp" | "words" | "reading" | "tournament" | "league";

export interface BadgeDef {
  code: string;
  emoji: string;
  title: string;
  description: string;
  category: BadgeCategory;
}

/** Numeric metrics available for threshold badges. */
export type ThresholdMetric = "streak" | "xp" | "words" | "reading";

export interface ThresholdBadge extends BadgeDef {
  metric: ThresholdMetric;
  threshold: number;
}

/** Threshold badges, auto-evaluated from user stats. */
export const THRESHOLD_BADGES: ThresholdBadge[] = [
  // 🔥 Streak (max_streak_record)
  { code: "streak_7",   emoji: "🔥", title: "زنجیره‌ی ۷ روزه",   description: "۷ روز پشت‌سرهم مطالعه", category: "streak", metric: "streak", threshold: 7 },
  { code: "streak_30",  emoji: "🔥", title: "زنجیره‌ی ۳۰ روزه",  description: "۳۰ روز پشت‌سرهم مطالعه", category: "streak", metric: "streak", threshold: 30 },
  { code: "streak_60",  emoji: "🔥", title: "زنجیره‌ی ۶۰ روزه",  description: "۶۰ روز پشت‌سرهم مطالعه", category: "streak", metric: "streak", threshold: 60 },
  { code: "streak_100", emoji: "🔥", title: "زنجیره‌ی ۱۰۰ روزه", description: "۱۰۰ روز پشت‌سرهم مطالعه", category: "streak", metric: "streak", threshold: 100 },
  { code: "streak_200", emoji: "🔥", title: "زنجیره‌ی ۲۰۰ روزه", description: "۲۰۰ روز پشت‌سرهم مطالعه", category: "streak", metric: "streak", threshold: 200 },

  // ⭐ Total XP
  { code: "xp_1k",   emoji: "⭐️", title: "۱۰۰۰ امتیاز",     description: "به ۱٬۰۰۰ XP رسیدی",       category: "xp", metric: "xp", threshold: 1000 },
  { code: "xp_5k",   emoji: "🌟", title: "۵۰۰۰ امتیاز",     description: "به ۵٬۰۰۰ XP رسیدی",       category: "xp", metric: "xp", threshold: 5000 },
  { code: "xp_10k",  emoji: "💫", title: "۱۰٬۰۰۰ امتیاز",   description: "به ۱۰٬۰۰۰ XP رسیدی",      category: "xp", metric: "xp", threshold: 10000 },
  { code: "xp_25k",  emoji: "🌠", title: "۲۵٬۰۰۰ امتیاز",   description: "به ۲۵٬۰۰۰ XP رسیدی",      category: "xp", metric: "xp", threshold: 25000 },
  { code: "xp_50k",  emoji: "🌌", title: "۵۰٬۰۰۰ امتیاز",   description: "به ۵۰٬۰۰۰ XP رسیدی",      category: "xp", metric: "xp", threshold: 50000 },
  { code: "xp_100k", emoji: "🏆", title: "۱۰۰٬۰۰۰ امتیاز",  description: "به ۱۰۰٬۰۰۰ XP رسیدی",     category: "xp", metric: "xp", threshold: 100000 },
  { code: "xp_200k", emoji: "🎖️", title: "۲۰۰٬۰۰۰ امتیاز",  description: "به ۲۰۰٬۰۰۰ XP رسیدی",     category: "xp", metric: "xp", threshold: 200000 },
  { code: "xp_500k", emoji: "🏅", title: "۵۰۰٬۰۰۰ امتیاز",  description: "به ۵۰۰٬۰۰۰ XP رسیدی",     category: "xp", metric: "xp", threshold: 500000 },
  { code: "xp_1m",   emoji: "💎", title: "یک میلیون امتیاز", description: "به ۱٬۰۰۰٬۰۰۰ XP رسیدی", category: "xp", metric: "xp", threshold: 1000000 },

  // 🧠 Words learned
  { code: "words_50",   emoji: "🧠", title: "۵۰ واژه",   description: "۵۰ واژه‌ی جدید یاد گرفتی",   category: "words", metric: "words", threshold: 50 },
  { code: "words_200",  emoji: "🧠", title: "۲۰۰ واژه",  description: "۲۰۰ واژه‌ی جدید یاد گرفتی",  category: "words", metric: "words", threshold: 200 },
  { code: "words_500",  emoji: "🧠", title: "۵۰۰ واژه",  description: "۵۰۰ واژه‌ی جدید یاد گرفتی",  category: "words", metric: "words", threshold: 500 },
  { code: "words_1000", emoji: "🧠", title: "۱۰۰۰ واژه", description: "۱٬۰۰۰ واژه‌ی جدید یاد گرفتی", category: "words", metric: "words", threshold: 1000 },
  { code: "words_2000", emoji: "🧠", title: "۲۰۰۰ واژه", description: "۲٬۰۰۰ واژه‌ی جدید یاد گرفتی", category: "words", metric: "words", threshold: 2000 },
  { code: "words_5000", emoji: "🎓", title: "۵۰۰۰ واژه", description: "۵٬۰۰۰ واژه‌ی جدید یاد گرفتی", category: "words", metric: "words", threshold: 5000 },

  // 📖 Reading sets
  { code: "reading_10",  emoji: "📖", title: "۱۰ درک مطلب",  description: "۱۰ تست درک مطلب کامل کردی",  category: "reading", metric: "reading", threshold: 10 },
  { code: "reading_50",  emoji: "📚", title: "۵۰ درک مطلب",  description: "۵۰ تست درک مطلب کامل کردی",  category: "reading", metric: "reading", threshold: 50 },
  { code: "reading_100", emoji: "📚", title: "۱۰۰ درک مطلب", description: "۱۰۰ تست درک مطلب کامل کردی", category: "reading", metric: "reading", threshold: 100 },
  { code: "reading_300", emoji: "🎓", title: "۳۰۰ درک مطلب", description: "۳۰۰ تست درک مطلب کامل کردی", category: "reading", metric: "reading", threshold: 300 },
];

/** Event badges, awarded at tournament/league settlement (not auto-evaluated). */
export const EVENT_BADGES: BadgeDef[] = [
  // 🎯 Tournament
  { code: "tourney_first",   emoji: "🎯", title: "اولین مسابقه",     description: "در اولین مسابقه‌ی روزانه شرکت کردی", category: "tournament" },
  { code: "tourney_10",      emoji: "🎯", title: "۱۰ مسابقه",        description: "در ۱۰ مسابقه شرکت کردی",            category: "tournament" },
  { code: "tourney_50",      emoji: "🎯", title: "۵۰ مسابقه",        description: "در ۵۰ مسابقه شرکت کردی",            category: "tournament" },
  { code: "tourney_100",     emoji: "🎯", title: "۱۰۰ مسابقه",       description: "در ۱۰۰ مسابقه شرکت کردی",           category: "tournament" },
  { code: "tourney_top3",    emoji: "🥉", title: "سکوی مسابقه",      description: "در یک مسابقه بین ۳ نفر برتر شدی",   category: "tournament" },
  { code: "tourney_win",     emoji: "🥇", title: "قهرمان مسابقه",    description: "یک مسابقه‌ی روزانه را بردی",        category: "tournament" },
  { code: "tourney_perfect", emoji: "💯", title: "مسابقه‌ی بی‌نقص",  description: "به همه‌ی سوال‌های یک مسابقه درست جواب دادی", category: "tournament" },

  // 🏅 League tiers reached + champion
  { code: "league_silver",   emoji: "🥈", title: "لیگ نقره",   description: "به لیگ نقره رسیدی",   category: "league" },
  { code: "league_gold",     emoji: "🥇", title: "لیگ طلا",    description: "به لیگ طلا رسیدی",    category: "league" },
  { code: "league_ruby",     emoji: "💎", title: "لیگ یاقوت",  description: "به لیگ یاقوت رسیدی",  category: "league" },
  { code: "league_diamond",  emoji: "💠", title: "لیگ الماس",  description: "به لیگ الماس رسیدی",  category: "league" },
  { code: "league_champion", emoji: "👑", title: "قهرمان لیگ", description: "در بالاترین لیگ قهرمان هفته شدی", category: "league" },
];

/** All badges, in display order (threshold groups then event groups). */
export const ALL_BADGES: BadgeDef[] = [...THRESHOLD_BADGES, ...EVENT_BADGES];

/** Lookup a badge definition by code. */
const BY_CODE = new Map<string, BadgeDef>(ALL_BADGES.map((b) => [b.code, b]));
export function badgeByCode(code: string): BadgeDef | undefined {
  return BY_CODE.get(code);
}

/** League tier number (2..5) → the badge code awarded for reaching it (or null). */
export function leagueTierBadgeCode(tier: number): string | null {
  switch (tier) {
    case 2: return "league_silver";
    case 3: return "league_gold";
    case 4: return "league_ruby";
    case 5: return "league_diamond";
    default: return null; // bronze (tier 1) has no "reached" badge
  }
}

/** Category display headers for the medals page. */
export const CATEGORY_LABELS: Record<BadgeCategory, string> = {
  streak: "🔥 زنجیره",
  xp: "⭐️ امتیاز",
  words: "🧠 واژگان",
  reading: "📖 درک مطلب",
  tournament: "🎯 مسابقه",
  league: "🏅 لیگ",
};

export const CATEGORY_ORDER: BadgeCategory[] = ["streak", "xp", "words", "reading", "tournament", "league"];

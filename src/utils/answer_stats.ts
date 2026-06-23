import { ANSWER_STATS_MIN_THRESHOLD } from "../config/constants";

export interface QuestionAnswerStats {
  correct: number;
  incorrect: number;
  total: number;
}

/**
 * Build a friendly "how others answered" line for a question's answer key.
 * Shows correct/incorrect percentages once enough answers exist; otherwise a
 * lighthearted "you're one of the first" message.
 * @param stats - Aggregated answer counts across all users for this question
 * @param minThreshold - Minimum total answers required to show percentages
 * @returns A Persian HTML string to append to the answer message
 */
export function formatAnswerStatsLine(
  stats: QuestionAnswerStats,
  minThreshold: number = ANSWER_STATS_MIN_THRESHOLD
): string {
  if (stats.total < minThreshold) {
    return `\n\n🌟 <i>تو از اولین‌هایی هستی که این سوال رو می‌زنه!</i>`;
  }

  const correctPct = Math.round((stats.correct / stats.total) * 100);
  const incorrectPct = 100 - correctPct;

  return (
    `\n\n📊 <i>بقیه چطور زدن:</i> ✅ ${correctPct}٪ درست | ❌ ${incorrectPct}٪ غلط ` +
    `(از ${stats.total} پاسخ)`
  );
}

import { Env } from "../../types";
import { DbUser } from "../../db/users";
import { sendMessage } from "../telegram-api";
import { TOURNAMENT_CONFIG } from "../../config/constants";
import { iranDateStr } from "../../utils/iran_time";
import { getTournamentByDate } from "../../db/tournaments";
import {
  getAttemptByQuizAndUser,
  getLeaderboardWithoutNegative,
  getFinishedAttemptsWithChatId,
} from "../../db/custom_quizzes";
import { beginOrResumeQuiz } from "./custom_quiz_user";
import { broadcast } from "./broadcast";

/** Medal/rank badge for a placement. */
function badge(rank: number): string {
  return rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `${rank}.`;
}

/**
 * Entry point for the "🎯 مسابقه" menu button: opens today's tournament, resumes
 * an in-progress attempt, or shows results once it has closed.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @returns void
 */
export async function showTournamentEntry(env: Env, user: DbUser, chatId: number): Promise<void> {
  const quiz = await getTournamentByDate(env, iranDateStr());
  if (!quiz) {
    await sendMessage(
      env,
      chatId,
      `🎯 <b>مسابقه‌ی امشب</b>\n\nهنوز مسابقه‌ای فعال نیست. هر شب ساعت ${TOURNAMENT_CONFIG.OPEN_HOUR}:۰۰ یک مسابقه‌ی جدید برگزار می‌شه — منتظرت هستیم! 🏆`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const now = Date.now();
  const opensMs = quiz.opens_at ? new Date(quiz.opens_at).getTime() : 0;
  const closesMs = quiz.closes_at ? new Date(quiz.closes_at).getTime() : Number.POSITIVE_INFINITY;
  const isClosed = quiz.status === "completed" || now >= closesMs;

  if (opensMs && now < opensMs) {
    await sendMessage(
      env,
      chatId,
      `🎯 <b>مسابقه‌ی امشب</b>\n\nهنوز شروع نشده! سر ساعت ${TOURNAMENT_CONFIG.OPEN_HOUR}:۰۰ برگزار می‌شه. آماده باش! ⏳`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (isClosed) {
    const attempt = await getAttemptByQuizAndUser(env, quiz.id, user.id);
    if (attempt) {
      // beginOrResumeQuiz shows results for a finished/expired attempt (and never
      // creates a new one because an attempt already exists).
      await beginOrResumeQuiz(env, user, chatId, quiz);
    } else {
      await sendTournamentTop(env, chatId, quiz.id);
    }
    return;
  }

  // Open now → begin or resume.
  await beginOrResumeQuiz(env, user, chatId, quiz);
}

/** Send a short top-placements summary for a closed tournament. */
async function sendTournamentTop(env: Env, chatId: number, quizId: number): Promise<void> {
  const board = await getLeaderboardWithoutNegative(env, quizId, 10);
  if (!board.length) {
    await sendMessage(env, chatId, "🏁 مسابقه‌ی امشب تموم شد، ولی کسی شرکت نکرد. فردا شب منتظرت هستیم! 🎯");
    return;
  }
  let text = "🏁 <b>نتایج مسابقه‌ی امشب</b>\n\n";
  for (const e of board) {
    text += `${badge(e.rank)} ${e.display_name} — ✅${e.correct}\n`;
  }
  text += "\nامشب شرکت نکردی؟ فردا شب حتماً بیا! 🎯";
  await sendMessage(env, chatId, text, { parse_mode: "HTML" });
}

/**
 * Broadcast final placements to every participant after settlement (participants
 * only — not the whole user base).
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The settled tournament's quiz id
 * @param ranking - Final ranking (rank, user_id, correct) from settleTournament
 * @returns Count of messages sent/failed
 */
export async function announceTournamentResults(
  env: Env,
  quizId: number,
  ranking: { rank: number; user_id: number; correct: number }[]
): Promise<{ sent: number; failed: number }> {
  const rankByUser = new Map(ranking.map((r) => [r.user_id, r]));
  const total = ranking.length;

  const finished = await getFinishedAttemptsWithChatId(env, quizId);
  const seen = new Set<number>();
  const recipients = finished.filter((a) => {
    if (seen.has(a.user_id)) return false;
    seen.add(a.user_id);
    return true;
  });

  return broadcast(env, recipients, (a) => {
    const r = rankByUser.get(a.user_id);
    if (!r) return null;
    let text =
      `🏁 <b>مسابقه‌ی امشب تموم شد!</b>\n\n` +
      `${badge(r.rank)} رتبه‌ی تو: <b>${r.rank}</b> از ${total}\n` +
      `✅ پاسخ‌های درست: ${r.correct}`;
    if (r.rank <= 3) {
      text += `\n\n🎉 تبریک! جزو نفرات برتر شدی و امتیاز ویژه گرفتی.`;
    }
    text += `\n\nفردا شب دوباره منتظرت هستیم! 🎯`;
    return { chatId: a.chat_id, text, extra: { parse_mode: "HTML" } };
  });
}

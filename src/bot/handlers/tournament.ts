import { Env } from "../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { DbUser, getOrCreateUser } from "../../db/users";
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup } from "../telegram-api";
import { TOURNAMENT_CONFIG, CB_PREFIX } from "../../config/constants";
import { iranDateStr, parseUtcStamp } from "../../utils/iran_time";
import {
  getTournamentByDate,
  settleTournament,
  claimTournamentAnnounce,
  clearTournamentAnnounceClaim,
  getTournamentReminder,
  toggleTournamentReminder,
} from "../../db/tournaments";
import {
  getAttemptByQuizAndUser,
  getLeaderboardWithoutNegative,
  getFinishedAttemptsWithChatId,
} from "../../db/custom_quizzes";
import { beginOrResumeQuiz } from "./custom_quiz_user";
import { broadcast } from "./broadcast";
import { badgeByCode } from "../../config/badges";
import { toPersianDigits } from "../../utils/digits";

/** Medal/rank badge for a placement. */
function badge(rank: number): string {
  return rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `${rank}.`;
}

/** Inline keyboard with the reminder opt-in toggle. */
function reminderKeyboard(optedIn: boolean): { inline_keyboard: InlineKeyboardButton[][] } {
  const label = optedIn ? "🔕 خاموش کردن یادآوری" : "🔔 یادم بنداز";
  return { inline_keyboard: [[{ text: label, callback_data: `${CB_PREFIX.TOURNAMENT}:remind` }]] };
}

/** Format an Iran wall-clock time (hour + minute) as a Persian-digit "HH:MM" label. */
function hhmmLabel(hour: number, minute: number): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return toPersianDigits(`${hh}:${mm}`);
}

/** The tournament's key wall-clock moments as Persian-digit "HH:MM" labels. */
const OPEN_LABEL = hhmmLabel(TOURNAMENT_CONFIG.OPEN_HOUR, 0); // ۲۱:۰۰ — window opens
const CLOSE_LABEL = hhmmLabel(TOURNAMENT_CONFIG.CLOSE_HOUR, 0); // ۲۲:۰۰ — results announced
// Latest a NEW attempt may start = OPEN_HOUR:00 + JOIN_WINDOW_MINUTES (e.g. ۲۱:۴۵).
const LAST_JOIN_TOTAL_MIN = TOURNAMENT_CONFIG.OPEN_HOUR * 60 + TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES;
const LAST_JOIN_LABEL = hhmmLabel(Math.floor(LAST_JOIN_TOTAL_MIN / 60), LAST_JOIN_TOTAL_MIN % 60);

/**
 * Shared "when can I play?" explainer, reused across the tournament messages so the
 * window is described identically everywhere: join is open OPEN→LAST_JOIN, results
 * land at CLOSE. Keeping it in one place is what makes the feature feel clear.
 */
const WINDOW_INFO =
  `⏰ ورود به مسابقه از ساعت <b>${OPEN_LABEL}</b> تا <b>${LAST_JOIN_LABEL}</b> بازه.\n` +
  `🏁 نتایج ساعت <b>${CLOSE_LABEL}</b> اعلام می‌شه.`;

/**
 * Entry point for the "🎯 مسابقه" menu button. Shows the schedule + reminder
 * toggle before open, runs the join-window logic while open (a late joiner can
 * still start until JOIN_WINDOW and always gets the full duration), and shows
 * results after close (settling lazily if the cron tick was missed).
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @returns void
 */
export async function showTournamentEntry(env: Env, user: DbUser, chatId: number): Promise<void> {
  // These two reads are independent — fire them together to save a round-trip.
  const [quiz, optedIn] = await Promise.all([
    getTournamentByDate(env, iranDateStr()),
    getTournamentReminder(env, user.id),
  ]);

  if (!quiz) {
    await sendMessage(
      env,
      chatId,
      `🎯 <b>مسابقه‌ی امشب</b>\n\n` +
        `هنوز شروع نشده. هر شب یک مسابقه‌ی تازه برگزار می‌شه — منتظرت هستیم! 🏆\n\n` +
        `${WINDOW_INFO}\n\n` +
        `می‌خوای هر شب سر ساعت ${OPEN_LABEL} یادت بندازم؟ دکمه‌ی زیر رو بزن 🔔`,
      { parse_mode: "HTML", reply_markup: reminderKeyboard(optedIn) }
    );
    return;
  }

  const now = Date.now();
  const opensMs = quiz.opens_at ? parseUtcStamp(quiz.opens_at).getTime() : 0;
  const closesMs = quiz.closes_at ? parseUtcStamp(quiz.closes_at).getTime() : Number.POSITIVE_INFINITY;
  const lastJoinMs = opensMs + TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES * 60 * 1000;

  // Not started yet.
  if (opensMs && now < opensMs) {
    await sendMessage(
      env,
      chatId,
      `🎯 <b>مسابقه‌ی امشب</b>\n\n` +
        `مسابقه ساعت <b>${OPEN_LABEL}</b> شروع می‌شه. آماده باش! ⏳\n\n` +
        `${WINDOW_INFO}`,
      { parse_mode: "HTML", reply_markup: reminderKeyboard(optedIn) }
    );
    return;
  }

  // Closed → settle lazily (idempotent, no broadcast) then show results.
  if (now >= closesMs || quiz.status === "completed") {
    if (quiz.status !== "completed") {
      try {
        // Settle THIS quiz's date (not iranDateStr(), which could roll past
        // midnight) so we never accidentally target a different day's tournament.
        await settleTournament(env, quiz.tournament_date ?? iranDateStr());
      } catch (err) {
        console.error("Lazy tournament settle error:", err);
      }
    }
    const attempt = await getAttemptByQuizAndUser(env, quiz.id, user.id);
    if (attempt) {
      // beginOrResumeQuiz shows results for a finished/expired attempt and never
      // creates a new one because an attempt already exists.
      await beginOrResumeQuiz(env, user, chatId, quiz);
    } else {
      await sendTournamentTop(env, chatId, quiz.id);
    }
    return;
  }

  // Window open. Resuming is always allowed; a NEW start only until lastJoin.
  const attempt = await getAttemptByQuizAndUser(env, quiz.id, user.id);
  if (attempt) {
    await beginOrResumeQuiz(env, user, chatId, quiz);
    return;
  }
  if (now < lastJoinMs) {
    await beginOrResumeQuiz(env, user, chatId, quiz);
    return;
  }
  // After the join window: no new attempts (so nobody is cut off mid-quiz).
  await sendMessage(
    env,
    chatId,
    `⏳ <b>پنجره‌ی ورود بسته شد</b>\n\n` +
      `ورود به مسابقه‌ی امشب فقط از ساعت ${OPEN_LABEL} تا ${LAST_JOIN_LABEL} باز بود.\n` +
      `🏁 نتایج ساعت ${CLOSE_LABEL} اعلام می‌شه.\n\n` +
      `فردا شب از ساعت ${OPEN_LABEL} زودتر بیا! 🎯`,
    { parse_mode: "HTML" }
  );
}

/** Toggle callback for the reminder opt-in button (CB_PREFIX.TOURNAMENT:remind). */
export async function handleTournamentCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const action = (callbackQuery.data || "").split(":")[1] || "";
  const msg = callbackQuery.message;
  if (action !== "remind" || !msg) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const user = await getOrCreateUser(env, callbackQuery.from);
  const optedIn = await toggleTournamentReminder(env, user.id);
  await answerCallbackQuery(
    env,
    callbackQuery.id,
    optedIn ? "🔔 هر شب یادت می‌ندازم!" : "🔕 یادآوری خاموش شد.",
    false
  );
  try {
    await editMessageReplyMarkup(env, msg.chat.id, msg.message_id, reminderKeyboard(optedIn));
  } catch {}
}

/** Send a short top-placements summary for a closed tournament. */
async function sendTournamentTop(env: Env, chatId: number, quizId: number): Promise<void> {
  const board = await getLeaderboardWithoutNegative(env, quizId, 10);
  if (!board.length) {
    await sendMessage(env, chatId, "🏁 مسابقه‌ی امشب تموم شد، ولی کسی شرکت نکرد. فردا شب منتظرت هستیم! 🎯");
    return;
  }
  // One blank line between ranks so each placement stands out clearly.
  let text = "🏁 <b>نتایج مسابقه‌ی امشب</b>\n\n";
  text += board.map((e) => `${badge(e.rank)} ${e.display_name} — ✅${e.correct}`).join("\n\n");
  text += "\n\nامشب شرکت نکردی؟ فردا شب حتماً بیا! 🎯";
  await sendMessage(env, chatId, text, { parse_mode: "HTML" });
}

/**
 * Broadcast final placements to every participant after settlement (participants
 * only), including any medals they just earned.
 * @param env - The worker environment containing the D1 database binding
 * @param quizId - The settled tournament's quiz id
 * @param ranking - Final ranking (rank, user_id, correct) from settleTournament
 * @param newBadgesByUser - Map of userId → newly-awarded badge codes
 * @returns Count of messages sent/failed
 */
export async function announceTournamentResults(
  env: Env,
  quizId: number,
  ranking: { rank: number; user_id: number; correct: number }[],
  newBadgesByUser: Map<number, string[]> = new Map()
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
    const medals = (newBadgesByUser.get(a.user_id) || [])
      .map((c) => badgeByCode(c))
      .filter(Boolean);
    if (medals.length) {
      text += `\n\n🏅 <b>مدال جدید:</b> ` + medals.map((m) => `${m!.emoji} ${m!.title}`).join("، ");
    }
    text += `\n\nفردا شب دوباره منتظرت هستیم! 🎯`;
    return { chatId: a.chat_id, text, extra: { parse_mode: "HTML" } };
  });
}

/**
 * Settle tonight's tournament (idempotent) and broadcast final placements to every
 * participant EXACTLY ONCE. This is the single entry point the cron uses at close.
 *
 * The announce is gated on claimTournamentAnnounce (a one-shot DB claim) rather
 * than on settleTournament's return value, which fixes the original bug: a user
 * opening the tournament right after close would settle it lazily first, making
 * the cron's settle return null and the broadcast never happen. Now settlement
 * and announcement are independent — whoever settles, the results still go out.
 *
 * Safe to call from more than one cron tick (e.g. a CLOSE_HOUR + backstop tick):
 * settlement is idempotent, the claim guarantees a single broadcast, and if the
 * broadcast itself throws the claim is rolled back so a later tick can retry
 * (at-least-once) without ever double-sending in the normal path (at-most-once).
 *
 * The broadcast runs here (cron context) and never on a user's button-press path,
 * so fanning out to hundreds of participants can't slow the interactive bot down.
 * @param env - The worker environment containing the D1 database binding
 * @param iranDate - Iran-local 'YYYY-MM-DD' identity of the tournament to close
 * @returns void
 */
export async function settleAndAnnounceTournament(env: Env, iranDate: string): Promise<void> {
  // Settle first (force-finish stragglers, award XP/badges, mark completed).
  // Returns null if it was already settled (e.g. by a lazy showTournamentEntry).
  const settled = await settleTournament(env, iranDate);

  // The settling call already gives us the quiz id in the happy path; only fall
  // back to a lookup when a lazy click settled it first (settled === null).
  let quizId: number;
  if (settled) {
    quizId = settled.quizId;
  } else {
    const quiz = await getTournamentByDate(env, iranDate);
    if (!quiz) return;
    quizId = quiz.id;
  }

  // Claim the single broadcast. Losers (already announced, or a concurrent
  // winner) return here without sending.
  const won = await claimTournamentAnnounce(env, quizId);
  if (!won) return;

  // Ranking + medals come from settlement when we settled it ourselves; otherwise
  // (a lazy click settled it first) recompute the ranking from the leaderboard.
  // The "new medal" line is only available on the settling call, so a lazily-
  // settled night simply omits it — the ranks/scores are always correct.
  let ranking = settled?.ranking;
  if (!ranking) {
    const board = await getLeaderboardWithoutNegative(env, quizId, 100000);
    ranking = board.map((r) => ({ rank: r.rank, user_id: r.user_id, correct: r.correct }));
  }
  const newBadgesByUser = settled?.newBadgesByUser ?? new Map<number, string[]>();

  try {
    await announceTournamentResults(env, quizId, ranking, newBadgesByUser);
  } catch (err) {
    // Broadcast failed as a whole (per-recipient failures are swallowed inside
    // broadcast()). Release the claim so the backstop tick retries.
    console.error("announceTournamentResults failed; releasing claim for retry:", err);
    try {
      await clearTournamentAnnounceClaim(env, quizId);
    } catch (clearErr) {
      console.error("Failed to release tournament announce claim:", clearErr);
    }
  }
}

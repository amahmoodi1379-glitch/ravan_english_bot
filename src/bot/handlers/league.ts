import { Env } from "../../types";
import { DbUser } from "../../db/users";
import { sendMessage } from "../telegram-api";
import {
  getUserLeagueState,
  getSettledResultsForWeek,
  lastEndedWeekStart,
  tierName,
  UserLeagueView,
  LeagueAnnounceRow,
} from "../../db/leagues";
import { broadcast } from "./broadcast";

/** Medal/rank badge for a placement. */
function badge(rank: number): string {
  return rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `${rank}.`;
}

/** Build the division board text for a user's current league view. */
function buildLeagueText(view: UserLeagueView, userId: number): string {
  const n = view.memberCount;
  const top = view.maxTier;

  let text = `🏅 <b>لیگ ${view.tierName}</b>\n`;
  text += `👥 ${n} نفر در دیویژن تو\n`;
  text += `⏳ تا شنبه فرصت داری امتیاز جمع کنی!\n\n`;

  view.standings.forEach((s, idx) => {
    const rank = idx + 1;
    let zone: string;
    if (view.tier === top && rank <= view.promoteCount) zone = "👑";
    else if (rank <= view.promoteCount && view.tier < top) zone = "🟢";
    else if (view.tier > 1 && rank > n - view.demoteCount) zone = "🔴";
    else zone = "⚪️";
    const you = s.user_id === userId ? " 👈" : "";
    text += `${zone} ${badge(rank)} ${s.display_name} — ${s.weekly_xp}${you}\n`;
  });

  text += `\n`;
  if (view.tier === top) {
    text += `👑 تو در بالاترین لیگی — قهرمان‌های این هفته از همین‌جا مشخص می‌شن!`;
  } else if (view.promoteCount > 0) {
    // Counts are dynamic (≈20% of this division's size), so they mirror the real
    // green/red zones above rather than a fixed number.
    text += `🟢 ${view.promoteCount} نفر برتر هفته‌ی بعد صعود می‌کنن`;
    if (view.tier > 1 && view.demoteCount > 0) {
      text += `\n🔴 ${view.demoteCount} نفر آخر یک لیگ سقوط می‌کنن`;
    }
  } else {
    // Division too small to rank meaningfully (≤2 people) — nobody moves.
    text += `👥 دیویژن تو هنوز کوچیکه — این هفته صعود و سقوطی نداریم، فقط امتیاز جمع کن!`;
  }
  return text;
}

/**
 * Entry point for the "🏅 لیگ" menu button: enrolls the user (lazily) and shows
 * their division standings with promotion / demotion zones.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID
 * @returns void
 */
export async function showLeagueHome(env: Env, user: DbUser, chatId: number): Promise<void> {
  const view = await getUserLeagueState(env, user.id);
  if (!view) {
    await sendMessage(env, chatId, "🏅 لیگ فعلاً در دسترس نیست. کمی بعد دوباره امتحان کن.");
    return;
  }
  await sendMessage(env, chatId, buildLeagueText(view, user.id), { parse_mode: "HTML" });
}

/** Build a personal end-of-week result message. */
function buildResultText(r: LeagueAnnounceRow): string {
  const fromTier = tierName(r.tier);
  const toTier = tierName(r.new_tier);
  let head: string;
  let medalLine = "";
  if (r.outcome === "promote") {
    head = `🎉 <b>صعود کردی!</b>\nاز لیگ ${fromTier} به لیگ ${toTier} رفتی!`;
    medalLine = `\n🏅 مدال «لیگ ${toTier}» رو گرفتی!`;
  } else if (r.outcome === "champion") {
    head = `👑 <b>قهرمان لیگ ${fromTier} شدی!</b>\nهفته‌ای فوق‌العاده داشتی!`;
    medalLine = `\n🏅 مدال «قهرمان لیگ» رو گرفتی!`;
  } else if (r.outcome === "demote") {
    head = `📉 به لیگ ${toTier} منتقل شدی.\nهفته‌ی بعد جبران کن! 💪`;
  } else {
    head = `✅ در لیگ ${fromTier} ماندگار شدی.`;
  }
  return (
    `${head}${medalLine}\n\n` +
    `🏅 رتبه‌ی تو در دیویژن: ${r.rank_in_division}\n` +
    `⭐️ امتیاز این هفته: ${r.weekly_xp}\n\n` +
    `هفته‌ی جدید شروع شد — دوباره بجنگ! 🏁`
  );
}

/**
 * Announce last week's settled league results to each active participant.
 * @param env - The worker environment containing the D1 database binding
 * @param nowMs - Optional epoch ms (defaults to now; use the Saturday-morning tick)
 * @returns Count of messages sent/failed
 */
export async function announceLeagueResults(
  env: Env,
  nowMs: number = Date.now()
): Promise<{ sent: number; failed: number }> {
  const weekStart = lastEndedWeekStart(nowMs);
  const rows = await getSettledResultsForWeek(env, weekStart);
  return broadcast(env, rows, (r) => ({
    chatId: r.telegram_id,
    text: buildResultText(r),
    extra: { parse_mode: "HTML" },
  }));
}

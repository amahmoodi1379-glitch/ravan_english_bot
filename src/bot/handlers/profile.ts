import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getProfileMenuKeyboard } from "../keyboards";
import { pe, isUserMenuLabel } from "../premium-emojis";
import { escapeHtml } from "../../utils/html";
import { getOrCreateUser, getUserByTelegramId, DbUser } from "../../db/users";
import { getAdminState, setAdminState, deleteAdminState } from "../../db/admin_state";
import {
  getUserProfile,
  updateDisplayName,
  validateDisplayName,
  setAvatar,
  getUserActivityStats,
  ActivityPeriod,
  ActivityStats
} from "../../db/profile";
import { CB_PREFIX, DISPLAY_NAME } from "../../config/constants";
import { toPersianDigits } from "../../utils/digits";
import { iranDateStr, shiftDateStr } from "../../utils/iran_time";
import { AVATARS, getAvatarEmoji, getAvatarLabel } from "../avatars";
import { toJalaliString } from "../../utils/jalali";
import { evaluateThresholdBadges } from "../../db/badges";
import { notifyNewBadges } from "./medals";

/**
 * Resolve the streak count to DISPLAY from a user's stored streak fields. A streak
 * only counts as "alive" if the last streak day is today or yesterday (Iran local);
 * otherwise it has lapsed and shows as 0. Pure/side-effect-free — the Iran-local
 * today/yesterday are computed in JS (via iranDateStr/shiftDateStr, the exact
 * equivalent of the old `date('now', '+3.5 hours')`), so this needs no DB round-trip
 * and is unit-testable. Replaces the previous two-query getStreakInfo.
 * @param streakCount - The user's stored streak_count
 * @param lastStreakDate - The user's stored last_streak_date ('YYYY-MM-DD', Iran local)
 * @param nowMs - Optional epoch ms (defaults to now)
 * @returns The streak to display (0 if lapsed or none)
 */
export function resolveStreakDisplay(
  streakCount: number | null | undefined,
  lastStreakDate: string | null | undefined,
  nowMs: number = Date.now()
): number {
  const count = streakCount || 0;
  if (count === 0) return 0;
  const lastDate = lastStreakDate || "";
  const today = iranDateStr(nowMs);
  const yesterday = shiftDateStr(today, -1);
  return lastDate === today || lastDate === yesterday ? count : 0;
}

/**
 * The name to show for a user: their chosen display name, falling back to the
 * Telegram first name / username, and finally a generated handle.
 * @param profileName - The stored display_name (may be null)
 * @param user - The database user record
 * @returns The name to render
 */
function resolveDisplayName(profileName: string | null | undefined, user: DbUser): string {
  return profileName || user.first_name || user.username || `user_${user.id}`;
}

/**
 * Display the user's profile home with name, XP, streak, and avatar.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the profile to
 * @returns void
 */
export async function showProfileHome(env: Env, user: DbUser, chatId: number): Promise<void> {
  const profile = await getUserProfile(env, user.id);

  const displayName = resolveDisplayName(profile?.display_name, user);

  const xpTotal = profile?.xp_total ?? 0;
  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);

  // Streak is derived from the fields already loaded by getUserProfile — no extra
  // read, and today/yesterday are computed in JS.
  const streakCount = resolveStreakDisplay(profile?.streak_count, profile?.last_streak_date);
  const streakText = streakCount > 0 ? `${pe("🔥")} <b>${streakCount}</b> روز` : "خاموش ❄️";

  const text =
    `${pe("👤")} <b>پروفایل کاربری</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🏷 نام: <b>${escapeHtml(displayName)}</b>\n` +
    `${pe("⭐️")} امتیاز: <b>${xpTotal}</b> XP\n` +
    `زنجیره مطالعه: ${streakText}\n` +
    `🖼 آواتار: ${avatarEmoji}\n\n` +
    `👇 از منوی زیر تنظیمات رو انتخاب کن:`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });

  // Catch-up: award any threshold medals the user has newly earned and announce them.
  const fresh = await evaluateThresholdBadges(env, user.id);
  await notifyNewBadges(env, chatId, fresh);
}

/**
 * Display the profile settings page with avatar selection and name change instructions.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the settings to
 * @returns void
 */
export async function showProfileSettings(env: Env, user: DbUser, chatId: number): Promise<void> {
  const profile = await getUserProfile(env, user.id);

  const displayName = resolveDisplayName(profile?.display_name, user);

  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);
  const avatarLabel = getAvatarLabel(profile?.avatar_code);

  const text =
    `⚙️ <b>تنظیمات پروفایل</b>\n\n` +
    `✏️ <b>نام نمایشی:</b> ${escapeHtml(displayName)}\n` +
    `<i>هر وقت خواستی می‌تونی عوضش کنی — بدون محدودیت 😊</i>\n\n` +
    `🎭 <b>آواتار فعلی:</b> ${avatarEmoji} (${avatarLabel})\n` +
    `برای تغییر، یکی از گزینه‌های زیر رو انتخاب کن: 👇`;

  const inlineRows: InlineKeyboardButton[][] = [
    [{ text: "✏️ تغییر نام نمایشی", callback_data: `${CB_PREFIX.NAME_EDIT}:1`, style: "primary" }]
  ];
  for (let i = 0; i < AVATARS.length; i += 4) {
    const slice = AVATARS.slice(i, i + 4);
    inlineRows.push(
      slice.map((a) => ({
        text: `${a.emoji}`,
        callback_data: `${CB_PREFIX.AVATAR}:${a.code}`
      }))
    );
  }

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: inlineRows
    }
  });
}

/**
 * Handle the avatar selection callback from the inline keyboard.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query containing the selected avatar code
 * @returns void
 */
export async function handleAvatarCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  if (parts.length !== 2 || parts[0] !== CB_PREFIX.AVATAR) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const code = parts[1];
  const avatar = AVATARS.find((a) => a.code === code);
  if (!avatar) {
    await answerCallbackQuery(env, callbackQuery.id, "آواتار نامعتبر است.");
    return;
  }

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const chatId = message.chat.id;
  const user = await getOrCreateUser(env, callbackQuery.from);

  await setAvatar(env, user.id, code);

  await answerCallbackQuery(env, callbackQuery.id, "آواتار جدید ثبت شد! 😍");

  const text = `${pe("🎉")} آواتار تو به ${avatar.emoji} <b>${avatar.label}</b> تغییر کرد! ${pe("✨")}`;
  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}

// ─────────────────────────── display-name change flow ────────────────────────
//
// Tap "✏️ تغییر نام نمایشی" → type the name → confirm. The typed name is parked
// in `admin_bot_state` (scope "profile") between the two steps, because a Persian
// name can fill Telegram's whole 64-byte callback_data budget on its own and so
// can't ride along on the confirm button.

interface ProfileState {
  action: "await_name" | "confirm_name";
  pendingName?: string;
}

/** The confirm / retype / cancel keyboard shown under a typed-in name. */
function nameConfirmKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [{ text: "✅ تایید و ثبت", callback_data: `${CB_PREFIX.NAME_SAVE}:1`, style: "success" }],
      [{ text: "✏️ نوشتن دوباره", callback_data: `${CB_PREFIX.NAME_EDIT}:1`, style: "primary" }],
      [{ text: "❌ انصراف", callback_data: `${CB_PREFIX.NAME_CANCEL}:1` }]
    ]
  };
}

/**
 * Ask the user to type a new display name (step 1 of the flow).
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to prompt in
 * @param note - Optional line shown above the prompt (e.g. a validation error)
 * @returns void
 */
export async function startNameChange(
  env: Env,
  user: DbUser,
  chatId: number,
  note?: string
): Promise<void> {
  const profile = await getUserProfile(env, user.id);
  const current = resolveDisplayName(profile?.display_name, user);

  await setAdminState<ProfileState>(env, user.telegram_id, "profile", { action: "await_name" });

  const text =
    (note ? `${note}\n\n` : "") +
    `✏️ <b>تغییر نام نمایشی</b>\n\n` +
    `اسم فعلیت: <b>${escapeHtml(current)}</b>\n\n` +
    `حالا اسم جدیدت رو همین‌جا بنویس و بفرست ✍️\n` +
    `<i>(حداکثر ${toPersianDigits(DISPLAY_NAME.MAX)} حرف — هر وقت خواستی می‌تونی دوباره عوضش کنی)</i>`;

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "❌ انصراف", callback_data: `${CB_PREFIX.NAME_CANCEL}:1` }]
      ]
    }
  });
}

/** Park a validated name and ask for confirmation (step 2 of the flow). */
async function askNameConfirm(
  env: Env,
  user: DbUser,
  chatId: number,
  name: string
): Promise<void> {
  await setAdminState<ProfileState>(env, user.telegram_id, "profile", {
    action: "confirm_name",
    pendingName: name
  });

  await sendMessage(
    env,
    chatId,
    `اسم جدیدت این می‌شه:\n\n${pe("🏷")} <b>${escapeHtml(name)}</b>\n\n` +
      `اگه درسته تاییدش کن 👇\n` +
      `<i>(اگه اشتباهه، کافیه اسم درست رو بنویسی و بفرستی)</i>`,
    { reply_markup: nameConfirmKeyboard() }
  );
}

/** Validate typed text and either re-prompt or move to the confirm step. */
async function takeTypedName(
  env: Env,
  user: DbUser,
  chatId: number,
  raw: string
): Promise<void> {
  const res = validateDisplayName(raw);
  if (!res.ok) {
    await sendMessage(env, chatId, `${res.reason}\n\nدوباره امتحان کن ✍️`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ انصراف", callback_data: `${CB_PREFIX.NAME_CANCEL}:1` }]
        ]
      }
    });
    return;
  }
  await askNameConfirm(env, user, chatId, res.value);
}

/**
 * Consume free text belonging to the name-change flow. Returns true if it
 * handled the message. A tap on a menu button (or any command) cancels the flow
 * and is handed back to the router.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param update - The incoming Telegram update
 * @returns True if the message was consumed by this flow
 */
export async function handleProfileMessage(
  env: Env,
  user: DbUser,
  update: TelegramUpdate
): Promise<boolean> {
  const message = update.message;
  const text = message?.text;
  if (!text) return false;

  const state = await getAdminState<ProfileState>(env, user.telegram_id, "profile");
  if (!state) return false;

  // A menu tap or a command means the user moved on — drop the flow and let the
  // router handle it, so neither can be mistaken for a name.
  if (isUserMenuLabel(text) || text.startsWith("/")) {
    await deleteAdminState(env, user.telegram_id, "profile");
    return false;
  }

  // In BOTH steps, typed text is the (possibly corrected) new name — retyping is
  // how the user fixes a typo without having to press anything first.
  await takeTypedName(env, user, message!.chat.id, text);
  return true;
}

/**
 * Handle the inline buttons of the name-change flow (start / save / cancel).
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query
 * @returns void
 */
export async function handleNameCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const prefix = (callbackQuery.data ?? "").split(":")[0];
  const chatId = callbackQuery.message?.chat.id;

  if (!callbackQuery.from || chatId === undefined) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const user = await getUserByTelegramId(env, callbackQuery.from.id);
  if (!user || !user.is_approved || user.is_banned) {
    await answerCallbackQuery(env, callbackQuery.id, "برای تغییر نام باید اشتراک فعال داشته باشی 🔒");
    return;
  }

  if (prefix === CB_PREFIX.NAME_CANCEL) {
    await deleteAdminState(env, user.telegram_id, "profile");
    await answerCallbackQuery(env, callbackQuery.id, "تغییر نام لغو شد");
    await sendMessage(env, chatId, "باشه، اسمت همون که بود موند 🙂", {
      reply_markup: getProfileMenuKeyboard()
    });
    return;
  }

  if (prefix === CB_PREFIX.NAME_EDIT) {
    await answerCallbackQuery(env, callbackQuery.id);
    await startNameChange(env, user, chatId);
    return;
  }

  // NAME_SAVE — the pending name lives in the flow state.
  const state = await getAdminState<ProfileState>(env, user.telegram_id, "profile");
  const pending = state?.action === "confirm_name" ? state.pendingName ?? "" : "";
  const res = validateDisplayName(pending);
  if (!res.ok) {
    await answerCallbackQuery(env, callbackQuery.id);
    await startNameChange(env, user, chatId, "این درخواست منقضی شده 🙃");
    return;
  }

  const result = await updateDisplayName(env, user.id, res.value);
  if (!result.ok) {
    await answerCallbackQuery(env, callbackQuery.id);
    await sendMessage(env, chatId, "❌ مشکلی در تغییر نام پیش آمد. دوباره امتحان کن.");
    return;
  }

  await deleteAdminState(env, user.telegram_id, "profile");
  await answerCallbackQuery(env, callbackQuery.id, "اسمت ثبت شد ✅");
  await sendMessage(
    env,
    chatId,
    `${pe("✨")} از این به بعد اسمت اینه: <b>${escapeHtml(res.value)}</b> ✅\n` +
      `<i>هر وقت خواستی دوباره از ⚙️ تنظیمات پروفایل عوضش کن.</i>`,
    { reply_markup: getProfileMenuKeyboard() }
  );
}

/**
 * Process the /setname command. Kept as a shortcut for users who know it:
 * "/setname رضا" jumps straight to the confirm step, a bare "/setname" (or an
 * invalid name, including the old "اسم_جدید" placeholder) starts the guided flow.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to respond to
 * @param text - The full command text (e.g., "/setname NewName")
 * @returns void
 */
export async function handleSetDisplayNameCommand(
  env: Env,
  user: DbUser,
  chatId: number,
  text: string
): Promise<void> {
  const arg = text.trim().replace(/^\/setname(?:@\S+)?/i, "").trim();

  if (!arg) {
    await startNameChange(env, user, chatId);
    return;
  }

  const res = validateDisplayName(arg);
  if (!res.ok) {
    await startNameChange(env, user, chatId, res.reason);
    return;
  }

  await askNameConfirm(env, user, chatId, res.value);
}

/**
 * Show the activity stats period selection menu.
 * @param env - The worker environment containing the bot token
 * @param chatId - The Telegram chat ID to send the period picker to
 * @returns void
 */
export async function startProfileStats(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env,
    chatId,
    `${pe("📊")} <b>آمار فعالیت</b>\n\nبازه‌ی زمانی رو انتخاب کن:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📅 امروز", callback_data: `${CB_PREFIX.STATS}:day`, style: "primary" }],
          [{ text: "🗓 ۷ روز اخیر", callback_data: `${CB_PREFIX.STATS}:week`, style: "primary" }],
          [{ text: "📆 ۳۰ روز اخیر", callback_data: `${CB_PREFIX.STATS}:month`, style: "primary" }],
          [{ text: "♾ همه‌ی زمان‌ها", callback_data: `${CB_PREFIX.STATS}:all`, style: "success" }]
        ]
      }
    }
  );
}

function periodLabel(period: ActivityPeriod): string {
  switch (period) {
    case "day": return "امروز";
    case "week": return "۷ روز اخیر";
    case "month": return "۳۰ روز اخیر";
    case "all": return "همه‌ی زمان‌ها";
  }
}

function buildStatsText(stats: ActivityStats): string {
  const label = periodLabel(stats.period);

  let text = `${pe("📊")} <b>گزارش عملکرد — ${label}</b>\n`;
  text += `━━━━━━━━━━━━━━\n\n`;

  text += `${pe("🧠")} <b>واژگان (لایتنر)</b>\n`;
  text += `  سوالات پاسخ‌داده: <b>${stats.leitner_questions}</b>\n`;
  if (stats.leitner_questions > 0) {
    const accuracy = Math.round((stats.leitner_correct / stats.leitner_questions) * 100);
    text += `  ✅ درست: <b>${stats.leitner_correct}</b>  ❌ غلط: <b>${stats.leitner_incorrect}</b>\n`;
    text += `  📈 دقت: <b>${accuracy}٪</b>\n`;
  }
  text += `  🆕 واژه‌های یادگرفته: <b>${stats.new_words_learned}</b>\n`;

  text += `\n${pe("📖")} <b>درک مطلب</b>\n`;
  text += `  تست‌های انجام‌شده: <b>${stats.reading_sets}</b>\n`;
  if (stats.reading_questions_total > 0) {
    const rAccuracy = Math.round((stats.reading_questions_correct / stats.reading_questions_total) * 100);
    text += `  سوالات: <b>${stats.reading_questions_correct}</b> درست از <b>${stats.reading_questions_total}</b> (${rAccuracy}٪)\n`;
  }

  text += `\n${pe("⭐️")} XP کسب شده: <b>${stats.xp}</b>`;

  return text;
}

/**
 * Handle the stats period selection callback and display activity statistics.
 * @param env - The worker environment containing the D1 database binding
 * @param callbackQuery - The Telegram callback query containing the chosen period
 * @returns void
 */
export async function handleStatsCallback(
  env: Env,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  const data = callbackQuery.data ?? "";
  const parts = data.split(":");

  if (parts.length !== 2 || parts[0] !== CB_PREFIX.STATS) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const period = parts[1] as ActivityPeriod;
  if (!["day", "week", "month", "all"].includes(period)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const chatId = message.chat.id;

  // Stop the spinner right away — the stats aggregation below gates no toast, so
  // there's no reason to hold the loading state through it.
  await answerCallbackQuery(env, callbackQuery.id);

  const user = await getOrCreateUser(env, callbackQuery.from);
  const stats = await getUserActivityStats(env, user.id, period);

  const text = buildStatsText(stats);
  await sendMessage(env, chatId, text);
}

/**
 * Show a concise profile summary card with name, XP, avatar, and join date.
 * @param env - The worker environment containing the D1 database binding
 * @param user - The database user record
 * @param chatId - The Telegram chat ID to send the summary to
 * @returns void
 */
export async function showProfileSummary(env: Env, user: DbUser, chatId: number): Promise<void> {
  const profile = await getUserProfile(env, user.id);

  const displayName = resolveDisplayName(profile?.display_name, user);

  const avatarEmoji = getAvatarEmoji(profile?.avatar_code);
  const xpTotal = profile?.xp_total ?? 0;

  const createdAt = profile?.created_at ?? "";
  const createdDateJalali = createdAt ? toJalaliString(createdAt) : "-";

  const text =
    `${pe("👑")} <b>کارت شناسایی زبان‌آموز</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `👤 نام: <b>${escapeHtml(displayName)}</b>\n` +
    `${pe("⭐️")} امتیاز کل: <b>${xpTotal}</b> XP\n` +
    `🎭 آواتار: ${avatarEmoji}\n` +
    `📅 تاریخ عضویت: <b>${createdDateJalali}</b>`;

  await sendMessage(env, chatId, text, {
    reply_markup: getProfileMenuKeyboard()
  });
}

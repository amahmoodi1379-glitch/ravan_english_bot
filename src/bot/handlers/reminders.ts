import { Env } from "../../types";
import { sendMessage } from "../telegram-api";
import { CB_PREFIX } from "../../config/constants";
import { getUsersForInactivityReminder, setReminderStage } from "../../db/notifications";
import { pe } from "../premium-emojis";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide which reminder stage to fire for a user given days inactive and the
 * stage already sent. Returns 0 when nothing should be sent.
 */
function targetStage(daysInactive: number, currentStage: number): number {
  if (daysInactive >= 10 && currentStage < 3) return 3;
  if (daysInactive >= 5 && currentStage < 2) return 2;
  if (daysInactive >= 2 && currentStage < 1) return 1;
  return 0;
}

function reminderText(stage: number): string {
  if (stage === 3) {
    return (
      `${pe("🚀")} <b>دلمون برات تنگ شده!</b>\n\n` +
      `۱۰ روزه که سری به واژه‌هات نزدی. زنجیره‌ی یادگیری با چند دقیقه تمرین دوباره جون می‌گیره ${pe("💪")}\n` +
      `همین الان یه شروع کوچیک بزن 👇`
    );
  }
  if (stage === 2) {
    return (
      `🌱 <b>وقتشه برگردی!</b>\n\n` +
      `۵ روزه ربات رو باز نکردی. واژه‌های آماده‌ی مرور منتظرتن تا فراموش نشن ${pe("🧠")}\n` +
      `یه تمرین کوتاه امروز کلی فرق ایجاد می‌کنه 👇`
    );
  }
  return (
    `${pe("👋")} <b>سلام! کجایی؟</b>\n\n` +
    `۲ روزه که تمرین نکردی. فقط چند دقیقه امروز کافیه تا روی فرم بمونی ${pe("✨")}\n` +
    `بزن بریم 👇`
  );
}

function reminderKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🧠 شروع مرور واژگان", callback_data: `${CB_PREFIX.REMINDER_OPEN}:leitner`, style: "success",}],
      [{ text: "📖 تست درک مطلب", callback_data: `${CB_PREFIX.REMINDER_OPEN}:reading`, style: "primary",}],
    ],
  };
}

/**
 * Send return-reminders to inactive subscribers at the 2/5/10-day thresholds.
 * Each user receives at most one reminder per stage; the stage is persisted after sending.
 * @param env - The worker environment containing the D1 database binding and bot token
 * @returns void
 */
export async function sendInactivityReminders(env: Env): Promise<void> {
  const candidates = await getUsersForInactivityReminder(env);
  let sent = 0;

  for (const u of candidates) {
    const stage = targetStage(u.days_inactive, u.inactivity_reminder_stage);
    if (stage === 0) continue;

    try {
      await sendMessage(env, u.telegram_id, reminderText(stage), { reply_markup: reminderKeyboard() });
    } catch (err) {
      // Even if delivery fails (e.g. the user blocked the bot — common for inactive
      // users), advance the stage anyway to avoid re-selecting them every cron run.
      console.error(`Inactivity reminder failed for ${u.telegram_id}:`, err);
    }

    try {
      await setReminderStage(env, u.id, stage);
    } catch (err) {
      console.error(`Failed to persist reminder stage for ${u.telegram_id}:`, err);
    }
    sent++;

    if (sent % 25 === 0) {
      await sleep(100);
    }
  }
}

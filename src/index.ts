import { Env } from "./types";
import { handleTelegramUpdate } from "./bot/router";
import { TelegramUpdate } from "./bot/types";
import { execute } from "./db/client";
import { handleAdminRequest } from "./admin/router";
import { sendInactivityReminders } from "./bot/handlers/reminders";
import { sendProgressReports } from "./bot/handlers/reports";
import { toJalaliParts } from "./utils/jalali";
import { createDailyTournament, getTournamentReminderOptIns } from "./db/tournaments";
import { settleAndAnnounceTournament } from "./bot/handlers/tournament";
import { settleLeague } from "./db/leagues";
import { announceLeagueResults } from "./bot/handlers/league";
import { broadcast } from "./bot/handlers/broadcast";
import { iranDateStr, iranWallClockToUtcStamp } from "./utils/iran_time";
import { toPersianDigits } from "./utils/digits";
import { TOURNAMENT_CONFIG, LEAGUE_CONFIG } from "./config/constants";
import { MAIN_MENU_BUTTON_TOURNAMENT } from "./bot/keyboards";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        const secretFromUrl = url.searchParams.get("secret");
        if (env.TELEGRAM_WEBHOOK_SECRET && secretFromUrl !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }
        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        ctx.waitUntil(handleTelegramUpdate(env, update));
        return new Response("OK", { status: 200 });
      }

      if (url.pathname.startsWith("/admin")) {
        return await handleAdminRequest(request, env);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return new Response("Bot is running! 🚀", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (err: unknown) {
      console.error("Global Error:", err);
      return new Response("Internal Server Error (Logged)", { status: 500 });
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        await execute(env, "DELETE FROM admin_sessions WHERE expires_at < datetime('now')");
      } catch (err) {
        console.error("Cleanup admin_sessions error:", err);
      }

      try {
        await execute(
          env,
          `DELETE FROM reading_sessions WHERE (status = 'in_progress' OR status = 'cancelled') AND started_at < datetime('now', '-1 day')`
        );
      } catch (err) {
        console.error("Cleanup reading_sessions error:", err);
      }

      // Cleanup orphaned reading question history (shown but never answered, older than 7 days)
      try {
        await execute(
          env,
          `DELETE FROM user_text_question_history WHERE answered_at IS NULL AND shown_at < datetime('now', '-7 days')`
        );
      } catch (err) {
        console.error("Cleanup orphaned reading question history error:", err);
      }

      // Cleanup stale admin bot state (older than 24 hours)
      try {
        await execute(env, `DELETE FROM admin_bot_state WHERE updated_at < datetime('now', '-24 hours')`);
      } catch (err) {
        console.error("Cleanup admin_bot_state error:", err);
      }

      // Cleanup expired quiz links (expired more than 7 days ago)
      try {
        await execute(
          env,
          `DELETE FROM custom_quiz_links WHERE expires_at IS NOT NULL AND expires_at < datetime('now', '-7 days')`
        );
      } catch (err) {
        console.error("Cleanup expired quiz links error:", err);
      }

      // Letters: 30-day retention. Delete old messages, then orphaned threads.
      // (The 7-day "unanswered drops out of inbox" rule is a read-time filter,
      // not a delete, so threads are never half-destroyed.)
      try {
        await execute(env, `DELETE FROM letter_messages WHERE created_at < datetime('now', '-30 days')`);
        await execute(
          env,
          `DELETE FROM letter_threads WHERE id NOT IN (SELECT DISTINCT thread_id FROM letter_messages)`
        );
      } catch (err) {
        console.error("Cleanup letters retention error:", err);
      }

      // License expiration: deactivate users whose license has expired
      try {
        await execute(
          env,
          `UPDATE users SET is_approved = 0, updated_at = datetime('now')
           WHERE is_approved = 1
             AND id IN (
               SELECT ac.used_by_user_id FROM access_codes ac
               WHERE ac.used_by_user_id IS NOT NULL
                 AND ac.expiration_days IS NOT NULL
                 AND ac.expiration_days > 0
                 AND datetime(ac.used_at, '+' || ac.expiration_days || ' days') < datetime('now')
             )
             AND id NOT IN (
               SELECT ac2.used_by_user_id FROM access_codes ac2
               WHERE ac2.used_by_user_id IS NOT NULL
                 AND (ac2.expiration_days IS NULL OR ac2.expiration_days = 0
                      OR datetime(ac2.used_at, '+' || ac2.expiration_days || ' days') >= datetime('now'))
             )`
        );
      } catch (err) {
        console.error("License expiration check error:", err);
      }

      const iranNow = new Date(Date.now() + 3.5 * 60 * 60 * 1000);
      const iranHour = iranNow.getUTCHours();

      // Return-reminders for inactive subscribers (2/5/10 days) — once daily at 10:00 Iran
      if (iranHour === 10) {
        try {
          await sendInactivityReminders(env);
        } catch (err) {
          console.error("Inactivity reminders error:", err);
        }
      }

      // Progress reports — at 21:00 Iran. Daily every day; weekly on Friday;
      // monthly on the last day of the Jalali month. Also opens tonight's
      // tournament (OPEN_HOUR is expected to equal 21) and folds its call-to-
      // action into the daily report so it reaches active users without a second
      // 500-user broadcast.
      if (iranHour === 21) {
        let tournamentCta: string | undefined;
        if (iranHour === TOURNAMENT_CONFIG.OPEN_HOUR) {
          try {
            // Pin the window to exactly OPEN_HOUR:00–CLOSE_HOUR:00 Iran from the
            // calendar, so it never drifts with the trigger's actual fire time.
            const iranDate = iranDateStr();
            const quizId = await createDailyTournament(
              env,
              iranDate,
              iranWallClockToUtcStamp(iranDate, TOURNAMENT_CONFIG.OPEN_HOUR),
              iranWallClockToUtcStamp(iranDate, TOURNAMENT_CONFIG.CLOSE_HOUR)
            );
            if (quizId) {
              const closeLabel = `${toPersianDigits(TOURNAMENT_CONFIG.CLOSE_HOUR)}:۰۰`;
              const lastJoinLabel =
                `${toPersianDigits(TOURNAMENT_CONFIG.OPEN_HOUR)}:` +
                `${toPersianDigits(String(TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES).padStart(2, "0"))}`;
              tournamentCta =
                `\n\n🎯 <b>مسابقه‌ی امشب شروع شد!</b>\n` +
                `تا ساعت ${closeLabel} فرصت داری. از دکمه‌ی «${MAIN_MENU_BUTTON_TOURNAMENT}» توی منو شرکت کن و با بقیه رقابت کن! 🏆`;

              // Dedicated opt-in reminder push to users who tapped "🔔 یادم بنداز"
              // (bounded to volunteers, and excludes users already active today so
              // nobody is pinged twice — see getTournamentReminderOptIns).
              try {
                const optIns = await getTournamentReminderOptIns(env);
                await broadcast(env, optIns, (u) => ({
                  chatId: u.telegram_id,
                  text:
                    `🎯 <b>مسابقه‌ی امشب شروع شد!</b>\n` +
                    `ورود تا ${lastJoinLabel} بازه و هرکس وارد بشه کل وقتش رو داره. الان بیا و با بقیه رقابت کن! 🏆`,
                  extra: { parse_mode: "HTML" },
                }));
              } catch (err) {
                console.error("Tournament reminder push error:", err);
              }
            }
          } catch (err) {
            console.error("Tournament open error:", err);
          }
        }

        try {
          await sendProgressReports(env, "daily", tournamentCta);
        } catch (err) {
          console.error("Daily progress report error:", err);
        }

        // Friday (Iran local) marks the end of the Persian week.
        if (iranNow.getUTCDay() === 5) {
          try {
            await sendProgressReports(env, "weekly");
          } catch (err) {
            console.error("Weekly progress report error:", err);
          }
        }

        // Last day of the Jalali month: tomorrow's Jalali day-of-month is 1.
        const tomorrow = new Date(iranNow.getTime() + 24 * 60 * 60 * 1000);
        const [, , tomorrowJd] = toJalaliParts(tomorrow);
        if (tomorrowJd === 1) {
          try {
            await sendProgressReports(env, "monthly");
          } catch (err) {
            console.error("Monthly progress report error:", err);
          }
        }
      }

      // Close & settle tonight's tournament, then push placements to every
      // participant. The broadcast is claimed exactly once (see
      // settleAndAnnounceTournament), so it fires even if a user's lazy settle
      // marked the quiz 'completed' first. We also retry on the following hour as
      // a backstop in case the CLOSE_HOUR tick was skipped entirely — the claim
      // makes the extra attempt a no-op once results have gone out.
      // Both settlement and the broadcast run here in cron context, never on a
      // user's button path, so the fan-out can't slow the interactive bot down.
      if (iranHour === TOURNAMENT_CONFIG.CLOSE_HOUR || iranHour === TOURNAMENT_CONFIG.CLOSE_HOUR + 1) {
        try {
          await settleAndAnnounceTournament(env, iranDateStr());
        } catch (err) {
          console.error("Tournament settle/announce error:", err);
        }
      }

      // League settlement at Iran Saturday 00:00 (the true week boundary, so
      // Friday-night activity counts fully). Idempotent per week.
      if (iranNow.getUTCDay() === 6 && iranHour === 0) {
        try {
          await settleLeague(env);
        } catch (err) {
          console.error("League settle error:", err);
        }
      }

      // League results announcement on Saturday morning. settleLeague first is a
      // catch-up in case the 00:00 tick was missed (idempotent).
      if (iranNow.getUTCDay() === 6 && iranHour === LEAGUE_CONFIG.ANNOUNCE_HOUR) {
        try {
          await settleLeague(env);
          await announceLeagueResults(env);
        } catch (err) {
          console.error("League announce error:", err);
        }
      }

      if (iranHour === 1) {
        try {
          await execute(env, "DELETE FROM activity_log WHERE created_at < datetime('now', '-60 days')");
        } catch (err) {
          console.error("Cleanup activity_log error:", err);
        }

        // Cleanup old answered leitner question history (>90 days)
        // This only removes dedup records; FSRS state (user_words_sm2) is preserved
        try {
          await execute(
            env,
            `DELETE FROM user_word_question_history WHERE answered_at IS NOT NULL AND answered_at < datetime('now', '-90 days')`
          );
        } catch (err) {
          console.error("Cleanup old question history error:", err);
        }

        // Cleanup unanswered leitner question history (>7 days)
        try {
          await execute(
            env,
            `DELETE FROM user_word_question_history WHERE answered_at IS NULL AND shown_at < datetime('now', '-7 days')`
          );
        } catch (err) {
          console.error("Cleanup unanswered question history error:", err);
        }
      }
    })());
  }
};

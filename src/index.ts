import { Env } from "./types";
import { handleTelegramUpdate, TelegramUpdate } from "./bot/router";
import { execute } from "./db/client";
import { handleAdminRequest } from "./admin/router";

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
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
    } catch (err: any) {
      console.error("Global Error:", err);
      return new Response("Internal Server Error (Logged)", { status: 500 });
    }
  },

  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
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

      const iranHour = new Date(Date.now() + 3.5 * 60 * 60 * 1000).getUTCHours();
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

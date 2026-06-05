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

      const iranHour = new Date(Date.now() + 3.5 * 60 * 60 * 1000).getUTCHours();
      if (iranHour === 1) {
        try {
          await execute(env, "DELETE FROM activity_log WHERE created_at < datetime('now', '-60 days')");
        } catch (err) {
          console.error("Cleanup activity_log error:", err);
        }
      }
    })());
  }
};

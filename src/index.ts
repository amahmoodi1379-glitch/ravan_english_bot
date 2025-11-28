import { Env } from "./types";
import { handleTelegramUpdate, TelegramUpdate } from "./bot/router";
import { queryAll, execute } from "./db/client";
import { cleanupOldMatches } from "./db/duels";
import { handleApiRequest } from "./api/router";
import { getMiniAppHtml } from "./web/views";
import { handleAdminRequest } from "./admin/router"; // <--- روتر ادمین
import { htmlResponse } from "./utils/response"; // <--- تابع کمکی مشترک

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    try {
      // 1. وب‌هوک تلگرام
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

      // 2. مینی‌اپ
      if (request.method === "GET" && url.pathname === "/webapp") {
        return htmlResponse(getMiniAppHtml());
      }

      // 3. API مینی‌اپ
      if (url.pathname.startsWith("/api/")) {
        return await handleApiRequest(request, env);
      }

      // 4. پنل ادمین (تمیز و منتقل شده!)
      if (url.pathname.startsWith("/admin")) {
        return await handleAdminRequest(request, env);
      }

      // 5. روت‌های دیباگ و روت اصلی
      if (request.method === "GET" && url.pathname === "/debug/db") {
        const words = await queryAll(env, "SELECT id, english, persian, level FROM words ORDER BY id LIMIT 20");
        return new Response(JSON.stringify(words, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
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
      return new Response("Internal Server Error", { status: 500 });
    }
  },
  
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil((async () => {
      console.log("🔄 Cleanup job...");
      await cleanupOldMatches(env);
      await execute(env, "DELETE FROM admin_sessions WHERE expires_at < datetime('now')");
      await execute(env, "DELETE FROM activity_log WHERE created_at < datetime('now', '-60 days')");
      await execute(env, `DELETE FROM reading_sessions WHERE status = 'in_progress' AND started_at < datetime('now', '-1 day')`);
      await execute(env, `DELETE FROM reflection_sessions WHERE ai_score IS NULL AND created_at < datetime('now', '-1 day')`);
      console.log("✅ Done.");
    })());
  }
};

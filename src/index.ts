import { Env } from "./types";
import { handleTelegramUpdate, TelegramUpdate } from "./bot/router";
import { queryAll, execute } from "./db/client";
import { handleAdminRequest } from "./admin/router";
import { runAutoQuestionGeneration } from "./cron/auto_generate_questions";

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

      // 2. پنل ادمین
      if (url.pathname.startsWith("/admin")) {
        return await handleAdminRequest(request, env);
      }

      // 3. روت‌های دیباگ و روت اصلی
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
      return new Response("Internal Server Error (Logged)", { status: 500 });
    }
  },
  
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil((async () => {
      console.log("🔄 Cron job started...");

      // ۱. تولید خودکار سوالات با AI
      try {
        const result = await runAutoQuestionGeneration(env);
        if (result.processed > 0) {
          console.log(`🤖 AI Generation: ${result.success} success, ${result.errors} errors out of ${result.processed} words`);
        }
      } catch (err) {
        console.error("AI Generation Error:", err);
      }

      // ۲. سشن‌های ادمین منقضی شده
      try {
        await execute(env, "DELETE FROM admin_sessions WHERE expires_at < datetime('now')");
      } catch (err) { console.error("Cleanup admin_sessions error:", err); }

      // ۳. لاگ فعالیت
      try {
        await execute(env, "DELETE FROM activity_log WHERE created_at < datetime('now', '-60 days')");
      } catch (err) { console.error("Cleanup activity_log error:", err); }

      // ۴. پاکسازی سشن‌های ریدینگ (هم نیمه‌کاره و هم کنسل‌شده) که قدیمی شده‌اند
      try {
        await execute(env, `DELETE FROM reading_sessions WHERE (status = 'in_progress' OR status = 'cancelled') AND started_at < datetime('now', '-1 day')`);
      } catch (err) { console.error("Cleanup reading_sessions error:", err); }

      // ۵. محاسبه آمار کاربران
      try {
        const { runAllAnalyticsCalculations } = await import("./db/analytics");
        await runAllAnalyticsCalculations(env);
        console.log("📊 Analytics calculations completed.");
      } catch (err) { 
        console.error("Analytics calculations error:", err); 
      }

      console.log("✅ Cron job complete.");
    })());
  }
};

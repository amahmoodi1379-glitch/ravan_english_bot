import { Env } from "./types";
import { handleTelegramUpdate, TelegramUpdate } from "./bot/router";
import { queryAll } from "./db/client";
import { getAllActiveReadingTexts } from "./db/texts";


export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // Webhook تلگرام
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      // چک کردن secret ساده برای امنیت بیشتر
      const secretFromUrl = url.searchParams.get("secret");
      const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;

      if (expectedSecret && secretFromUrl !== expectedSecret) {
        return new Response("Forbidden", { status: 403 });
      }

      let update: TelegramUpdate;
      try {
        update = (await request.json()) as TelegramUpdate;
      } catch (e) {
        return new Response("Bad Request", { status: 400 });
      }

      // هندل کردن آپدیت تلگرام
      ctx.waitUntil(handleTelegramUpdate(env, update));

      // تلگرام فقط 200 OK می‌خواد
      return new Response("OK", { status: 200 });
    }

        // تست دیتابیس: برگرداندن لیست واژه‌ها به صورت JSON
    if (request.method === "GET" && url.pathname === "/debug/db") {
      try {
        const words = await queryAll(env, "SELECT id, english, persian, level FROM words ORDER BY id LIMIT 20");
        return new Response(JSON.stringify(words, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response("DB error: " + String(err), { status: 500 });
      }
    }

        // تست reading: لیست متن‌ها
    if (request.method === "GET" && url.pathname === "/debug/reading-texts") {
      try {
        const texts = await getAllActiveReadingTexts(env);
        return new Response(JSON.stringify(texts, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response("Reading DB error: " + String(err), { status: 500 });
      }
    }

        // دیباگ: لیست کاربران و XP
    if (request.method === "GET" && url.pathname === "/debug/users") {
      try {
        const users = await queryAll(
          env,
          `
          SELECT id, telegram_id, display_name, xp_total
          FROM users
          ORDER BY id ASC
          `
        );
        return new Response(JSON.stringify(users, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response("Users DB error: " + String(err), { status: 500 });
      }
    }


    // یک روت ساده برای تست
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK from ravan_english_bot Worker ✅", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};

import { Env } from "../types";
import { getNextLeitnerQuestionAPI, submitAnswerAPI } from "./handlers/leitner";
import { validateInitData } from "../utils/auth";
import { getUserByTelegramId } from "../db/users";

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // --- Middleware امنیتی و شناسایی کاربر ---
  let dbUserId: number | null = null;

  // 1. دریافت initData از هدر Authorization
  const authHeader = request.headers.get("Authorization");
  
  if (authHeader) {
    // الف) اعتبارسنجی و گرفتن آیدی تلگرام
    const telegramId = await validateInitData(authHeader, env.TELEGRAM_BOT_TOKEN);
    
    if (telegramId) {
        // ب) تبدیل آیدی تلگرام به آیدی دیتابیس
        const user = await getUserByTelegramId(env, telegramId);
        if (user) {
            // 🛑 چک کردن لایسنس (فیکس امنیتی)
            if (!user.is_approved) {
                return new Response(JSON.stringify({ error: "License Required" }), {
                    status: 403, // کد ۴۰۳ یعنی ممنوع
                    headers: { "Content-Type": "application/json" }
                });
            }
            dbUserId = user.id;
        }
    }
  }

  // اگر کاربر پیدا نشد یا معتبر نبود
  if (!dbUserId) {
    return new Response(JSON.stringify({ error: "Unauthorized User" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  // -------------------------

  // حالا همه درخواست‌ها با dbUserId واقعی و تایید شده انجام می‌شوند:

  // دریافت سوال بعدی
  if (request.method === "GET" && url.pathname === "/api/leitner/next") {
    return await getNextLeitnerQuestionAPI(env, dbUserId);
  }

  // ثبت جواب
  if (request.method === "POST" && url.pathname === "/api/leitner/answer") {
    try {
      const body = await request.json() as any;
      if (!body.questionId || !body.option) {
        return new Response(JSON.stringify({ error: "Missing data" }), { status: 400 });
      }
      return await submitAnswerAPI(env, dbUserId, body.questionId, body.option);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Server Error" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

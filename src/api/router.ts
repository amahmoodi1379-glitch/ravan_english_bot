import { Env } from "../types";
import { getNextLeitnerQuestionAPI, submitAnswerAPI } from "./handlers/leitner";
import { validateInitData } from "../utils/auth";

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // --- Middleware امنیتی ---
  // این بخش وظیفه احراز هویت را انجام می‌دهد
  let userId: number | null = null;

  // 1. دریافت initData از هدر Authorization
  const authHeader = request.headers.get("Authorization");
  
  if (authHeader) {
    // اعتبارسنجی داده‌های تلگرام
    userId = await validateInitData(authHeader, env.TELEGRAM_BOT_TOKEN);
  }

  // اگر احراز هویت شکست خورد، ارور 401 برمی‌گردانیم
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized / Invalid Telegram Data" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  // -------------------------

  // حالا که مطمئنیم userId معتبر و واقعی است، درخواست‌ها را پردازش می‌کنیم:

  // مسیر دریافت سوال بعدی
  if (request.method === "GET" && url.pathname === "/api/leitner/next") {
    return await getNextLeitnerQuestionAPI(env, userId);
  }

  // مسیر ثبت جواب کاربر
  if (request.method === "POST" && url.pathname === "/api/leitner/answer") {
    try {
      const body = await request.json() as any;
      // اعتبارسنجی ورودی‌ها
      if (!body.questionId || !body.option) {
        return new Response(JSON.stringify({ error: "Missing data" }), { status: 400 });
      }
      return await submitAnswerAPI(env, userId, body.questionId, body.option);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }
  }

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

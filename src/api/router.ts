// فایل: src/api/router.ts
import { Env } from "../types";
import { getNextLeitnerQuestionAPI } from "./handlers/leitner";

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  
  // مسیر دریافت سوال بعدی
  if (request.method === "GET" && url.pathname === "/api/leitner/next") {
    const uid = url.searchParams.get("uid");
    const userId = uid ? Number(uid) : 0;
    
    // اینجا باید احراز هویت انجام شود (فعلا به آیدی اعتماد میکنیم)
    if (!userId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    return await getNextLeitnerQuestionAPI(env, userId);
  }

  // اینجا می‌توانید مسیرهای دیگر مثل /api/leitner/answer یا /api/profile را اضافه کنید

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

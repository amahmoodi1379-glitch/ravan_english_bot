import { Env } from "../types";
// فقط یک خط ایمپورت تمیز و کامل:
import { getNextLeitnerQuestionAPI, submitAnswerAPI } from "./handlers/leitner";

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  
  // مسیر دریافت سوال بعدی
  if (request.method === "GET" && url.pathname === "/api/leitner/next") {
    const uid = url.searchParams.get("uid");
    const userId = uid ? Number(uid) : 0;
    
    if (!userId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    return await getNextLeitnerQuestionAPI(env, userId);
  }

  // مسیر ثبت جواب کاربر
  if (request.method === "POST" && url.pathname === "/api/leitner/answer") {
    try {
      const body = await request.json() as any;
      if (!body.userId || !body.questionId || !body.option) {
        return new Response(JSON.stringify({ error: "Missing data" }), { status: 400 });
      }
      return await submitAnswerAPI(env, body.userId, body.questionId, body.option);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
    }
  }

  return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
}

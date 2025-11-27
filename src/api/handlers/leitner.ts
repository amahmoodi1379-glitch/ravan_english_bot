// فایل: src/api/handlers/leitner.ts
import { Env } from "../../types";
import { pickNextWordForUser } from "../../db/leitner"; // استفاده از کد موجود
import { queryOne } from "../../db/client";

// این تابع مسئول ساختن JSON برای سوال بعدی است
export async function getNextLeitnerQuestionAPI(env: Env, userId: number): Promise<Response> {
  const word = await pickNextWordForUser(env, userId);

  if (!word) {
    return new Response(JSON.stringify({ status: 'empty' }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // گرفتن یک سوال رندوم برای این کلمه (ساده‌سازی شده برای API)
  // در کد اصلی شما logic پیچیده‌تری بود که می‌توان عیناً اینجا آورد
  // اما برای شروع ساده نگه می‌داریم
  const question = await queryOne<{
    id: number; 
    question_text: string; 
    option_a: string; 
    option_b: string; 
    option_c: string; 
    option_d: string;
  }>(env, 
    `SELECT * FROM word_questions WHERE word_id = ? ORDER BY RANDOM() LIMIT 1`, 
    [word.id]
  );

  if (!question) {
     // اگر کلمه هست ولی سوال ندارد (حالت خاص)
     return new Response(JSON.stringify({ status: 'empty' }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({
    status: 'ok',
    id: question.id,
    word: word.english,
    question: question.question_text,
    options: [question.option_a, question.option_b, question.option_c, question.option_d]
  }), {
    headers: { "Content-Type": "application/json" }
  });
}

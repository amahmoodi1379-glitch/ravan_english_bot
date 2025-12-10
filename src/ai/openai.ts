import { Env } from "../types";

export interface AiGeneratedQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface AiReflectionResult {
  score: number;
  feedback: string;
}

/**
 * تابع اصلی برای صحبت با OpenAI از طریق Responses API
 * اینجا فقط model + input می‌فرستیم (مثل /debug/openai-ping که جواب داد)
 */
async function callOpenAI(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    throw new Error("OPENAI_API_KEY is not set");
  }

  // آدرس مستقیم OpenAI – هیچ BASE_URL جداگانه‌ای استفاده نکن
  const url = "https://api.openai.com/v1/responses";

  // متن نهایی ورودی مدل (system + user در یک رشته)
  const combinedInput = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`;

  // Timeout برای جلوگیری از گیر کردن Worker
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn("[OpenAI] Aborting /v1/responses request after 20000ms timeout");
    controller.abort();
  }, 20000); // ۲۰ ثانیه

  try {
    console.log("[OpenAI] Calling gpt-5-nano via Responses API (combined input)...");

    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: combinedInput,
        max_output_tokens: 1024,
        temperature: 1,
        reasoning: {
          effort: "low", // برای سرعت بیشتر
        },
      }),
    });

    console.log("[OpenAI] Response status", resp.status);

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[OpenAI Error body]:", errText);
      throw new Error(`OpenAI API Error: ${resp.status}`);
    }

    const data: any = await resp.json();
    const text = extractTextFromResponse(data);

    return (text || "").trim();
  } catch (err) {
    console.error("[OpenAI Fetch Error]:", err);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * خروجی Responses API برای gpt-5-nano چیزی شبیه همینیه که خودت از /debug/openai-ping دیدی:
 * output: [
 *   { type: "reasoning", ... },
 *   { type: "message", content: [ { type: "output_text", text: "..." } ] }
 * ]
 * این تابع متن رو از اون ساختار درمیاره.
 */
function extractTextFromResponse(data: any): string {
  try {
    if (!data || !Array.isArray(data.output)) return "";

    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c.text === "string") {
            return c.text;
          }
        }
      }
    }
    return "";
  } catch (e) {
    console.error("extractTextFromResponse error:", e);
    return "";
  }
}

// -------------------- لایتنر واژگان --------------------

export async function generateWordQuestionsWithOpenAI(params: {
  env: Env;
  english: string;
  persian: string;
  level: number;
  questionStyle: string;
  count: number;
}): Promise<AiGeneratedQuestion[]> {
  const { env, english, persian, level, questionStyle, count } = params;

  const userPrompt = `
Target word: "${english}" (${persian})
Level: ${level}
Question style: ${questionStyle}

Generate ${count} multiple-choice vocabulary questions.
Each question MUST have exactly 4 options.
Return ONLY valid JSON with this structure exactly:
{
  "questions": [
    {
      "question": "string",
      "options": ["string","string","string","string"],
      "correct_index": 0,
      "explanation": "string"
    }
  ]
}
`;

  const systemPrompt = "You are a vocabulary quiz generator. Always answer with strict JSON only, no extra text.";

  const raw = await callOpenAI(env, systemPrompt, userPrompt);
  return parseJsonResult(raw, count);
}

// -------------------- درک مطلب --------------------

export async function generateReadingQuestionsWithOpenAI(
  env: Env,
  textBody: string,
  count: number = 3
): Promise<AiGeneratedQuestion[]> {
  const userPrompt = `
Text:
"""${textBody}"""

Generate ${count} reading comprehension multiple-choice questions (۴ options).
Return ONLY valid JSON with this structure exactly:
{
  "questions": [
    {
      "question": "string",
      "options": ["string","string","string","string"],
      "correct_index": 0,
      "explanation": "string"
    }
  ]
}
`;

  const systemPrompt = "You are an English reading comprehension test generator. Always answer with strict JSON only, no extra text.";
  const raw = await callOpenAI(env, systemPrompt, userPrompt);
  return parseJsonResult(raw, count);
}

// -------------------- پاراگراف روانشناسی --------------------

export async function generateReflectionParagraph(
  env: Env,
  words: string[],
  level: string
): Promise<string> {
  const userPrompt = `
Write a short psychology-related English paragraph (about 80-120 words) for learner level ${level}.
Try to naturally use these words: ${words.join(", ")}.
Output only the paragraph in English, no explanations, no translation.
`;
  const systemPrompt = "You are a psychology English tutor writing simple but natural English.";

  return await callOpenAI(env, systemPrompt, userPrompt);
}

// -------------------- تصحیح خلاصه‌ی کاربر --------------------

export async function evaluateReflection(
  env: Env,
  sourceText: string,
  userAnswer: string
): Promise<AiReflectionResult> {
  const userPrompt = `
Original text:
"""${sourceText}"""

Student summary:
"""${userAnswer}"""

Evaluate how well the student understood the text.
Return ONLY valid JSON like:
{
  "score": 0-10,
  "feedback": "Persian feedback for the student"
}
`;
  const systemPrompt = "You are a bilingual (English/Persian) English teacher. Reply only JSON, feedback in Persian.";

  const raw = await callOpenAI(env, systemPrompt, userPrompt);

  try {
    const parsed = parseSafeJson(raw);
    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch (e) {
    console.error("evaluateReflection JSON parse error:", e, "raw:", raw);
    return { score: 0, feedback: "⚠️ خطا در تحلیل پاسخ. لطفاً بعداً دوباره امتحان کنید." };
  }
}

// -------------------- توابع کمکی JSON --------------------

function parseJsonResult(raw: string, limit: number): AiGeneratedQuestion[] {
  try {
    const parsed = parseSafeJson(raw);
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];

    return list.slice(0, limit).map((q: any) => ({
      question: q.question ?? "",
      options: q.options ?? [],
      correctIndex: q.correct_index ?? q.correctIndex ?? 0,
      explanation: q.explanation ?? "",
    }));
  } catch (e) {
    console.error("parseJsonResult error:", e, "raw:", raw);
    return [];
  }
}

function parseSafeJson(text: string): any {
  if (!text) throw new Error("Empty JSON text");
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

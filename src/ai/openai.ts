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
 * تابع اصلی برای صحبت با OpenAI
 */
async function callOpenAI(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    throw new Error("OPENAI_API_KEY is not set");
  }

  const url = "https://api.openai.com/v1/responses";
  const combinedInput = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userPrompt}`;

  const controller = new AbortController();
  // تایم‌اوت را روی ۲۵ ثانیه نگه می‌داریم
  const timeoutId = setTimeout(() => {
    console.warn("[OpenAI] Timeout - Aborting request");
    controller.abort();
  }, 25000);

  try {
    console.log("[OpenAI] Sending request..."); // لاگ شروع

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
        temperature: 1, // برگشت به دمای پیش‌فرض
      }),
    });

    console.log("[OpenAI] Response Status:", resp.status); // لاگ وضعیت

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[OpenAI Error Body]:", errText);
      throw new Error(`OpenAI API Error: ${resp.status}`);
    }

    const data: any = await resp.json();
    
    // استخراج متن
    const text = extractTextFromResponse(data);
    
    // اگر متن خالی بود، کل دیتای دریافتی را لاگ می‌کنیم تا بفهمیم ساختار چیست
    if (!text) {
        console.error("[OpenAI] No text extracted! Full response:", JSON.stringify(data));
    } else {
        console.log("[OpenAI] Text extracted length:", text.length);
        // console.log("[OpenAI] Snippet:", text.substring(0, 100));
    }

    return text.trim();

  } catch (err) {
    console.error("[OpenAI Fetch Error]:", err);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

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
    console.error("[Extract Error]", e);
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
Target word: "${english}" (Persian meaning: ${persian})
Level: ${level}
Question style: ${questionStyle}

Generate ${count} multiple-choice questions.
Exactly 4 options per question.

*** RULES ***
1. Correct answer must be clear.
2. Distractors must be same part of speech.
3. Distractors must be different in meaning (balanced difficulty).
4. Return ONLY valid JSON.

JSON Format:
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

  const systemPrompt = "You are an English vocabulary quiz generator. Return valid JSON only.";

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
Text: """${textBody}"""

Generate ${count} reading comprehension questions (4 options).
Return ONLY valid JSON:
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

  const systemPrompt = "You are a reading comprehension test generator. Return JSON only.";
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
Write a short psychology English paragraph (80-100 words) for level ${level}.
Use words: ${words.join(", ")}.
Output only the text.
`;
  const systemPrompt = "You are a psychology English tutor.";

  return await callOpenAI(env, systemPrompt, userPrompt);
}

// -------------------- تصحیح خلاصه --------------------

export async function evaluateReflection(
  env: Env,
  sourceText: string,
  userAnswer: string
): Promise<AiReflectionResult> {
  const userPrompt = `
Text: """${sourceText}"""
Summary: """${userAnswer}"""

Evaluate understanding (0-10) and feedback in Persian.
JSON Only:
{
  "score": 0,
  "feedback": "string"
}
`;
  const systemPrompt = "English teacher. Reply JSON.";

  const raw = await callOpenAI(env, systemPrompt, userPrompt);

  try {
    const parsed = parseSafeJson(raw);
    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch (e) {
    return { score: 0, feedback: "خطا در تحلیل." };
  }
}

// -------------------- ابزارها --------------------

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
    console.error("JSON Parse Error:", e);
    console.error("Raw text was:", raw); // لاگ متن خام برای دیباگ
    return [];
  }
}

function parseSafeJson(text: string): any {
  if (!text) return {};
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

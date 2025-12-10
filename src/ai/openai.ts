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
  // تغییر: زمان انتظار را روی ۲۵ ثانیه تنظیم کردیم تا قبل از قطع شدن توسط کلادفلر (۳۰ ثانیه)، خودمان بفهمیم
  const timeoutId = setTimeout(() => {
    console.warn("[OpenAI] Timeout - Aborting request");
    controller.abort();
  }, 25000);

  try {
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
        // تغییر: چون فقط ۱ سوال می‌سازیم، ۱۰۲۴ توکن کاملاً کافی و سریع است
        max_output_tokens: 1024, 
        temperature: 1, 
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[OpenAI Error]:", errText);
      throw new Error(`OpenAI API Error: ${resp.status}`);
    }

    const data: any = await resp.json();
    return extractTextFromResponse(data).trim();
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

  // پرامپت با منطق متعادل (Balanced)
  const userPrompt = `
Target word: "${english}" (Persian meaning: ${persian})
Level: ${level}
Question style: ${questionStyle}

Generate ${count} multiple-choice questions.
Exactly 4 options per question.

*** CRITICAL RULES FOR OPTIONS ***
1. The correct answer MUST be clear.
2. Distractors (wrong options) MUST be the **same part of speech** (noun, verb, adj) as the correct answer.
3. Distractors should be **conceptually related** but **clearly different** in meaning.
   - Good Example for 'Blue': [Red, Green, Yellow, Blue] (All colors, but clear distinction).
   - Bad Example: [Car, Book, Eat, Blue] (Too random).
4. If style is "fa_meaning", distractors must be Persian meanings of other words in the same category.

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

  const systemPrompt = "You are an expert English teacher. Create balanced vocabulary quizzes. Return JSON only.";

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

Generate ${count} reading comprehension multiple-choice questions (4 options).
The correct option must be strictly based on the text.
The wrong options must be plausible but clearly incorrect.

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

  const systemPrompt = "You are an English reading comprehension test generator. Return JSON only.";
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
Output only the paragraph in English.
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
Original text: """${sourceText}"""
Student summary: """${userAnswer}"""

Evaluate understanding.
Return ONLY valid JSON:
{
  "score": 0-10,
  "feedback": "Persian feedback"
}
`;
  const systemPrompt = "You are a bilingual English teacher. Reply JSON only.";

  const raw = await callOpenAI(env, systemPrompt, userPrompt);

  try {
    const parsed = parseSafeJson(raw);
    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch (e) {
    return { score: 0, feedback: "خطا در تحلیل پاسخ." };
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
    console.error("JSON Parse Error", e);
    return [];
  }
}

function parseSafeJson(text: string): any {
  if (!text) return {};
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

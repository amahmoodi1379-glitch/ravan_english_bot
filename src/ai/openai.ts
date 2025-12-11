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
  // تایم‌اوت را روی ۲۸ ثانیه می‌گذاریم (حداکثر زمان مجاز ورکر)
  const timeoutId = setTimeout(() => {
    console.warn("[OpenAI] Timeout - Aborting request");
    controller.abort();
  }, 28000);

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
        max_output_tokens: 1000, 
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

  // پرامپت با تاکید بر فرمت صحیح
  const userPrompt = `
Target word: "${english}" (Persian: ${persian})
Level: ${level}
Style: ${questionStyle}

Generate ${count} multiple-choice question(s).
- Correct answer must be clear.
- Distractors must be strictly related (same part of speech) but clearly wrong in meaning.
- Return ONLY raw JSON. No markdown formatting.

Format:
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

  const systemPrompt = "You are a quiz generator. Output strict JSON only. No reasoning text in output.";

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

Generate ${count} reading questions.
- 4 options each.
- Strict JSON output.

Format:
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

  const systemPrompt = "You are a reading test generator. Output strict JSON only.";
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
Write a short psychology text (80 words) for level ${level}.
Use: ${words.join(", ")}.
Output only the English text.
`;
  const systemPrompt = "You are an English tutor.";

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

Evaluate (0-10) & feedback (Persian).
JSON:
{
  "score": 0,
  "feedback": "string"
}
`;
  const systemPrompt = "Teacher. Reply JSON.";

  const raw = await callOpenAI(env, systemPrompt, userPrompt);

  try {
    const parsed = parseSafeJson(raw);
    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch (e) {
    return { score: 0, feedback: "Error parsing result." };
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
    console.error("JSON Parse Error. Raw:", raw);
    return [];
  }
}

function parseSafeJson(text: string): any {
  if (!text) return {};
  // حذف مارک‌داون‌های احتمالی که مدل ممکن است اضافه کند
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

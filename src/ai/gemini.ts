import { Env } from "../types";

export interface AiGeneratedQuestion {
  question: string;
  options: string[]; // length = 4
  correctIndex: number; // 0..3
  explanation: string;
}

async function callGemini(env: Env, prompt: string): Promise<string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    throw new Error("GEMINI_API_KEY is not set");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Gemini HTTP error", resp.status, text);
    throw new Error("Gemini HTTP error: " + resp.status);
  }

  const data = await resp.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (typeof text !== "string") {
    console.error("Gemini response has no text", JSON.stringify(data));
    throw new Error("Gemini response has no text");
  }

  return text.trim();
}

function buildWordQuestionPrompt(params: {
  english: string;
  persian: string;
  level: number;
  questionStyle: string;
  count: number;
}): string {
  const { english, persian, level, questionStyle, count } = params;

  return `
You are an expert English vocabulary quiz generator for Persian (Farsi) learners.

Target word: "${english}"
Main Persian meaning: "${persian}"
Approximate difficulty level: ${level} (1 = very easy, 4 = hard).

question_style = "${questionStyle}"
Generate ${count} different multiple-choice questions for this word with exactly 4 options each.

Styles rules:

- "fa_meaning":
  * Question text: in Persian, asking for the meaning of the English word "${english}".
  * Options: 4 Persian meanings (short phrases). Exactly one is the correct meaning "${persian}", the others are plausible but wrong.

- "en_definition":
  * Question text: in Persian, asking something like "کدام تعریف برای واژه ${english} درست است؟".
  * Options: 4 simple English definitions. Exactly one is correct.

- "word_from_definition":
  * Question text: a simple English definition.
  * Options: 4 English words. Exactly one is the target word "${english}". Others are plausible but wrong.

- "synonym":
  * Question text: in Persian, asking for a synonym of "${english}".
  * Options: 4 English words. Exactly one is a close synonym, others are plausible but wrong.

- "antonym":
  * Question text: in Persian, asking for an opposite/antonym of "${english}".
  * Options: 4 English words. Exactly one is a good antonym, others are plausible but wrong.

- "fa_to_en":
  * Question text: show the Persian meaning "${persian}" and ask which English word matches it.
  * Options: 4 English words. Exactly one is "${english}", others are plausible but wrong.

For each question, also give a short explanation in Persian (why the correct answer is correct).

Return ONLY valid JSON (no extra text, no markdown) in this exact format:

{
  "questions": [
    {
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correct_index": 0,
      "explanation": "..."
    }
  ]
}
`.trim();
}

export async function generateWordQuestionsWithGemini(params: {
  env: Env;
  english: string;
  persian: string;
  level: number;
  questionStyle: string;
  count: number;
}): Promise<AiGeneratedQuestion[]> {
  const { env, english, persian, level, questionStyle, count } = params;

  const prompt = buildWordQuestionPrompt({
    english,
    persian,
    level,
    questionStyle,
    count
  });

  let raw = await callGemini(env, prompt);

  // اگر مدل کدبلاک markdown برگردونه، پاکش می‌کنیم
  raw = raw.replace(/```json/g, "").replace(/```/g, "").trim();

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to parse Gemini JSON:", raw);
    throw err;
  }

  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const result: AiGeneratedQuestion[] = [];

  for (const q of list) {
    if (
      !q ||
      typeof q.question !== "string" ||
      !Array.isArray(q.options) ||
      q.options.length < 4
    ) {
      continue;
    }
    const opts = q.options.slice(0, 4).map((o: any) => String(o));
    let idx: number = 0;
    if (typeof q.correct_index === "number") {
      idx = q.correct_index;
    } else if (typeof q.correctIndex === "number") {
      idx = q.correctIndex;
    }
    if (idx < 0 || idx > 3) idx = 0;

    result.push({
      question: q.question,
      options: opts,
      correctIndex: idx,
      explanation: typeof q.explanation === "string" ? q.explanation : ""
    });

    if (result.length >= count) break;
  }

  return result;
}

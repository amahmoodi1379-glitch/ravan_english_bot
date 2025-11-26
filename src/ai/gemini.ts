import { Env } from "../types";

export interface AiGeneratedQuestion {
  question: string;
  options: string[]; // length = 4
  correctIndex: number; // 0..3
  explanation: string;
}

export interface AiReflectionResult {
  score: number; // 0-10
  feedback: string;
}

// لیست مدل‌ها برای تلاش (اولویت با مدل‌های جدیدتر)
const MODELS_TO_TRY = [
  "gemini-2.5-flash", // ✅ مدل جدید که شما تأیید کردید کار می‌کند
  "gemini-1.5-flash-latest", 
  "gemini-1.5-flash"
];

async function callGemini(env: Env, prompt: string): Promise<string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    throw new Error("GEMINI_API_KEY is not set");
  }

  let lastError: any;

  for (const model of MODELS_TO_TRY) {
    try {
      console.log(`Trying Gemini model: ${model}...`);
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` +
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
        if (resp.status === 404) {
          console.warn(`Model ${model} not found (404). Trying next...`);
          lastError = new Error(`Gemini ${model} 404: ${text}`);
          continue;
        }
        console.error(`Gemini HTTP error for ${model}`, resp.status, text);
        lastError = new Error(`Gemini HTTP error: ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ??
        data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (typeof text !== "string") {
        console.error(`Gemini response for ${model} has no text`, JSON.stringify(data));
        lastError = new Error("Gemini response has no text");
        continue;
      }

      return text.trim();

    } catch (err) {
      console.error(`Exception calling model ${model}:`, err);
      lastError = err;
    }
  }

  throw lastError || new Error("All Gemini models failed.");
}

// --- بخش لایتنر ---

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
- "fa_meaning": Question in Persian asking for meaning of "${english}". Options: 4 Persian meanings.
- "en_definition": Question in Persian asking "Which definition is correct for ${english}?". Options: 4 English definitions.
- "word_from_definition": Question is an English definition. Options: 4 English words.
- "synonym": Question in Persian asking for synonym. Options: 4 English words.
- "antonym": Question in Persian asking for antonym. Options: 4 English words.
- "fa_to_en": Question is Persian meaning "${persian}". Options: 4 English words.

For each question, also give a short explanation in Persian.

Return ONLY valid JSON in this format:
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
  const prompt = buildWordQuestionPrompt(params);
  let raw = await callGemini(params.env, prompt);
  return parseGeminiJson(raw, params.count);
}

// --- بخش درک مطلب (Reading) ---

export async function generateReadingQuestionsWithGemini(
  env: Env,
  textBody: string,
  count: number = 3
): Promise<AiGeneratedQuestion[]> {
  const prompt = `
You are an expert English reading comprehension test generator.

Read the following text carefully:
"""
${textBody}
"""

Generate ${count} multiple-choice questions based on the text above.
- The questions must be in English.
- The options must be in English.
- There must be exactly 4 options per question.
- Provide a short explanation (in English) why the answer is correct, referencing the text.

Return ONLY valid JSON in this exact format (no markdown, no extra text):
{
  "questions": [
    {
      "question": "Question text here?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_index": 0,
      "explanation": "Explanation here."
    }
  ]
}
`.trim();

  let raw = await callGemini(env, prompt);
  return parseGeminiJson(raw, count);
}

function parseGeminiJson(raw: string, limit: number): AiGeneratedQuestion[] {
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
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options) || q.options.length < 4) {
      continue;
    }
    const opts = q.options.slice(0, 4).map((o: any) => String(o));
    let idx = 0;
    if (typeof q.correct_index === "number") idx = q.correct_index;
    else if (typeof q.correctIndex === "number") idx = q.correctIndex;
    if (idx < 0 || idx > 3) idx = 0;

    result.push({
      question: q.question,
      options: opts,
      correctIndex: idx,
      explanation: typeof q.explanation === "string" ? q.explanation : ""
    });

    if (result.length >= limit) break;
  }
  return result;
}

// --- بخش جدید: برداشت از متن (Reflection) ---

export async function generateReflectionParagraph(
  env: Env,
  words: string[]
): Promise<string> {
  const wordsList = words.join(", ");
  const prompt = `
You are an English tutor. Write a short, engaging paragraph (about 60-100 words) suitable for an English learner.
Try to include some of the following words naturally: ${wordsList}.
If the list is empty, just write a general paragraph about "Daily Habits" or "Travel".
The paragraph should be simple and clear.
Return ONLY the paragraph text.
`.trim();

  return await callGemini(env, prompt);
}

export async function evaluateReflection(
  env: Env,
  sourceText: string,
  userAnswer: string
): Promise<AiReflectionResult> {
  const prompt = `
You are an English teacher evaluating a student's reflection.

Source Text:
"""
${sourceText}
"""

Student's Reflection/Summary:
"""
${userAnswer}
"""

Task:
1. Give a score from 0 to 10 based on how well the student understood the text and expressed their thoughts.
2. Provide short feedback in Persian (Farsi). Point out any major grammar mistakes or praise good vocabulary. If it looks like a direct translation, mention it.

Return ONLY valid JSON in this format:
{
  "score": 8,
  "feedback": "..."
}
`.trim();

  const raw = await callGemini(env, prompt);
  const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  
  try {
    const parsed = JSON.parse(cleaned);
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : "بازخوردی ثبت نشد."
    };
  } catch (e) {
    console.error("Failed to parse reflection evaluation:", cleaned);
    return { score: 0, feedback: "خطا در دریافت بازخورد هوش مصنوعی." };
  }
}

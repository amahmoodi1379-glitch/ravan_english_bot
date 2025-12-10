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

// تابع اصلی ارتباط با ChatGPT
async function callOpenAI(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = env.OPENAI_API_KEY; // نام متغیر محیطی جدید
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const url = "https://api.openai.com/v1/chat/completions";

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini", // یا gpt-3.5-turbo (مدل اقتصادی و سریع)
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("OpenAI Error:", errText);
    throw new Error(`OpenAI API Error: ${resp.status}`);
  }

  const data: any = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// --- بخش لایتنر ---
export async function generateWordQuestionsWithOpenAI(params: {
  env: Env;
  english: string;
  persian: string;
  level: number;
  questionStyle: string;
  count: number;
}): Promise<AiGeneratedQuestion[]> {
  const prompt = `
Target word: "${params.english}" (${params.persian})
Level: A1-A2
Style: ${params.questionStyle}
Generate ${params.count} multiple-choice questions.
JSON format only: { "questions": [{ "question": "...", "options": ["A","B","C","D"], "correct_index": 0, "explanation": "..." }] }
`;

  const raw = await callOpenAI(params.env, "You are a vocabulary quiz generator. Output valid JSON only.", prompt);
  return parseJsonResult(raw, params.count);
}

// --- بخش درک مطلب ---
export async function generateReadingQuestionsWithOpenAI(
  env: Env,
  textBody: string,
  count: number = 3
): Promise<AiGeneratedQuestion[]> {
  const prompt = `
Text: """${textBody}"""
Generate ${count} reading comprehension questions.
JSON format only: { "questions": [{ "question": "...", "options": ["...","...","...","..."], "correct_index": 0, "explanation": "..." }] }
`;

  const raw = await callOpenAI(env, "You are a reading test generator. Output valid JSON only.", prompt);
  return parseJsonResult(raw, count);
}

// --- بخش متن روانشناسی ---
export async function generateReflectionParagraph(
  env: Env,
  words: string[],
  level: string 
): Promise<string> {
  const prompt = `Write a short Psychology-related paragraph (60-100 words) for English learner level ${level}.
Try to use these words: ${words.join(", ")}.`;

  return await callOpenAI(env, "You are a psychology English tutor.", prompt);
}

// --- بخش تصحیح متن ---
export async function evaluateReflection(
  env: Env,
  sourceText: string,
  userAnswer: string
): Promise<AiReflectionResult> {
  const prompt = `
Source: """${sourceText}"""
Student Summary: """${userAnswer}"""
Evaluate comprehension (0-10) and give Persian feedback.
JSON format only: { "score": 8, "feedback": "..." }
`;

  const raw = await callOpenAI(env, "You are an English teacher. Output valid JSON only.", prompt);
  try {
    const parsed = parseSafeJson(raw);
    return { score: parsed.score || 0, feedback: parsed.feedback || "" };
  } catch {
    return { score: 0, feedback: "خطا در تحلیل پاسخ." };
  }
}

// توابع کمکی
function parseJsonResult(raw: string, limit: number): AiGeneratedQuestion[] {
  try {
    const parsed = parseSafeJson(raw);
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    return list.slice(0, limit).map((q: any) => ({
      question: q.question,
      options: q.options,
      correctIndex: q.correct_index ?? q.correctIndex ?? 0,
      explanation: q.explanation ?? ""
    }));
  } catch (e) {
    console.error("JSON Parse Error:", e);
    return [];
  }
}

function parseSafeJson(text: string): any {
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

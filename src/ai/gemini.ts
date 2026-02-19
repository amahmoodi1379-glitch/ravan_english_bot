// ماژول ارتباط با OpenAI API

import { Env } from "../types";

// --- تنظیمات ارتباط با OpenAI ---
const OPENAI_URL = "https://api.openai.com/v1/chat/completions"; // آدرس استاندارد
const DEFAULT_MODEL = "gpt-4o-mini"; // مدل پیشنهادی و ارزان

async function callOpenAI(env: Env, systemPrompt: string, userPrompt: string, jsonMode: boolean = false): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing!");
    throw new Error("کلید هوش مصنوعی تنظیم نشده است.");
  }

  const model = env.OPENAI_MODEL || DEFAULT_MODEL;

  const payload: any = {
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 1000,
    temperature: 0.7,
  };

  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data: any = await res.json();
    
    if (!res.ok) {
      console.error("OpenAI Error:", data);
      throw new Error(data?.error?.message || "خطا در ارتباط با هوش مصنوعی");
    }

    return data.choices?.[0]?.message?.content || "";
  } catch (error) {
    console.error("AI Fetch Error:", error);
    throw error;
  }
}

// --- ۱. تولید متن برای رفلکشن ---
// این تابع با ۳ ورودی (محیط، کلمات، سطح) صدا زده می‌شود
export async function generateReflectionParagraph(env: Env, words: string[] | string, level: string): Promise<string> {
  const wordsStr = Array.isArray(words) ? words.join(", ") : words;
  
  const system = "You are an expert ESL teacher. Write a short, engaging paragraph for a student.";
  const prompt = `
    Write a short paragraph (about 80-120 words) in English.
    Difficulty Level: ${level}
    
    Must include these words naturally: ${wordsStr}
    
    Topic: Psychology or General Life (make it interesting).
    Return ONLY the paragraph text. No intro, no markdown.
  `;

  return await callOpenAI(env, system, prompt);
}

// --- ۲. تصحیح رفلکشن ---
// این تابع با ۳ ورودی (محیط، متن اصلی، جواب کاربر) صدا زده می‌شود
export async function evaluateReflection(env: Env, sourceText: string, userAnswer: string): Promise<{ score: number; feedback: string }> {
  const system = "You are a supportive ESL teacher. Evaluate the student's summary/reflection. Respond in JSON.";
  const prompt = `
    Source Text: """${sourceText}"""
    
    Student's Reflection: """${userAnswer}"""
    
    Task:
    1. Give a score from 0 to 10 based on comprehension and grammar.
    2. Write a short, helpful feedback in Persian (فارسی).
    
    Output JSON format:
    {
      "score": number,
      "feedback": "string (in Persian)"
    }
  `;

  const raw = await callOpenAI(env, system, prompt, true);
  try {
    return JSON.parse(raw);
  } catch {
    return { score: 5, feedback: "متاسفانه در خواندن پاسخ هوش مصنوعی خطایی رخ داد، اما تمرین شما ثبت شد." };
  }
}

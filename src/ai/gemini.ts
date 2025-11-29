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

const MODELS_TO_TRY = [
  "gemini-2.0-flash", 
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
Learner Level: A1 (Beginner/Elementary)

question_style = "${questionStyle}"
Generate ${count} multiple-choice questions for this word.

*** CRITICAL RULES FOR OPTIONS (DISTRACTORS) ***
1. Distractors must be **semantically related** or share the same **part of speech** (noun, verb, adj).
2. Do NOT use random unrelated words. Make it tricky/professional.
   - Bad: Apple (Options: Run, Blue, Car, Apple)
   - Good: Apple (Options: Banana, Orange, Pear, Apple)
3. For "fa_meaning", distractors must be Persian meanings of *other* related English words.

*** CRITICAL RULES FOR DEFINITIONS ***
1. Definitions MUST be very short (max 10-12 words).
2. Use SIMPLE words (A1 level).
   - Good: "A round fruit that is red or green."
   - Bad: "The pome fruit of a tree of the rose family..."

Styles rules:
- "fa_meaning": Question: "معنی کلمه ${english} چیست؟". Options: 4 Persian meanings.
- "en_definition": Question: "Which definition describes '${english}'?". Options: 4 simple English definitions.
- "word_from_definition": Question: A simple definition is given. Options: 4 English words.
- "synonym": Question: "Which word is a synonym for ${english}?". Options: 4 English words.
- "antonym": Question: "Which word is an antonym (opposite) for ${english}?". Options: 4 English words.

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
  let parsed: any;
  try {
    parsed = safeExtractJson(raw);
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


export async function generateReflectionParagraph(
  env: Env,
  words: string[],
  level: string 
): Promise<string> {
  const wordsList = words.join(", ");
  
  const prompt = `
You are an English tutor specializing in Psychology and Mental Health.
Write a short, engaging paragraph (about 60-100 words) for an English learner at Level ${level}.

The topic MUST be related to **Psychology** or **Mental Health** (e.g., stress, happiness, habits, emotions, mindfulness).

Try to include some of the following words naturally if they fit the context: ${wordsList}.
If the words don't fit well, prioritize the flow and the psychology topic.

The text should be suitable for reading comprehension and reflection.
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
2. Provide short feedback in Persian (Farsi). Point out any major grammar mistakes or praise good vocabulary.

Return ONLY valid JSON in this format:
{
  "score": 8,
  "feedback": "..."
}
`.trim();

  const raw = await callGemini(env, prompt);
  
  try {
    const parsed = safeExtractJson(raw);
    
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : "بازخوردی ثبت نشد."
    };
  } catch (e) {
    console.error("Failed to parse reflection evaluation:", raw);
    return { score: 0, feedback: "خطا در دریافت بازخورد هوش مصنوعی." };
  }
}

function safeExtractJson(raw: string): any {
  let text = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const firstOpen = text.indexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    text = text.substring(firstOpen, lastClose + 1);
  }
  return JSON.parse(text);
}

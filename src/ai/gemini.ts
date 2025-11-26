import { Env } from "../types";

export type QuestionStyle =
  | "fa_meaning"
  | "en_definition"
  | "word_from_definition"
  | "synonym"
  | "antonym"
  | "fa_to_en";

export interface GeneratedWordQuestion {
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: "A" | "B" | "C" | "D";
  explanation: string;
}

interface DbWord {
  id: number;
  english: string;
  persian: string;
  level?: number;
  lesson_name?: string | null;
  synonyms?: string | null;
  antonyms?: string | null;
}

function buildStyleInstruction(style: QuestionStyle, word: DbWord): string {
  const base =
    `You are an exam generator for Persian learners of English.\n` +
    `Target word: "${word.english}". Persian meaning: "${word.persian}".\n`;

  switch (style) {
    case "fa_meaning":
      return (
        base +
        `Create multiple-choice questions where the question shows the ENGLISH word, and 4 options are PERSIAN meanings.\n` +
        `Only one Persian meaning is correct. The other options must be plausible but incorrect meanings in Persian.`
      );
    case "en_definition":
      return (
        base +
        `Create multiple-choice questions where the question shows the ENGLISH word, and 4 options are SIMPLE ENGLISH definitions.\n` +
        `Only one definition is correct. Other options are plausible but incorrect definitions.`
      );
    case "word_from_definition":
      return (
        base +
        `Create multiple-choice questions where the question shows a SIMPLE ENGLISH DEFINITION, and the 4 options are ENGLISH WORDS.\n` +
        `Only one option must be exactly the target word "${word.english}". The other options must be different words.`
      );
    case "synonym":
      return (
        base +
        `Create multiple-choice questions where the question shows the ENGLISH word, and 4 options are ENGLISH synonyms / near-synonyms.\n` +
        `Only one option is a good synonym for the target word. Other options must be different words.`
      );
    case "antonym":
      return (
        base +
        `Create multiple-choice questions where the question shows the ENGLISH word, and 4 options are ENGLISH antonyms.\n` +
        `Only one option is a good antonym. Other options must be different words.`
      );
    case "fa_to_en":
      return (
        base +
        `Create multiple-choice questions where the question shows the PERSIAN meaning, and 4 options are ENGLISH words.\n` +
        `Only one option is exactly the correct English word. Other options must be plausible but incorrect words.`
      );
  }
}

function buildWordPrompt(
  word: DbWord,
  style: QuestionStyle,
  count: number
): string {
  const styleInstruction = buildStyleInstruction(style, word);

  return (
    styleInstruction +
    `\n\nGenerate exactly ${count} questions.\n` +
    `Return ONLY valid JSON, no extra text.\n` +
    `The JSON must be an array of objects with this exact shape:\n` +
    `[\n` +
    `  {\n` +
    `    "question_text": "string",\n` +
    `    "option_a": "string",\n` +
    `    "option_b": "string",\n` +
    `    "option_c": "string",\n` +
    `    "option_d": "string",\n` +
    `    "correct_option": "A" | "B" | "C" | "D",\n` +
    `    "explanation": "string"\n` +
    `  }, ...\n` +
    `]\n` +
    `Make all text UTF-8 plain text, no markdown.`
  );
}

async function callGemini(env: Env, prompt: string): Promise<string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in environment");
  }

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      "Gemini API error: " + res.status + " " + res.statusText + " – " + text
    );
  }

  const data = await res.json();

  const parts =
    data?.candidates?.[0]?.content?.parts ??
    data?.candidates?.[0]?.output_text ??
    [];

  let text = "";
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p?.text === "string") {
        text += p.text;
      }
    }
  } else if (typeof parts === "string") {
    text = parts;
  }

  return text.trim();
}

function extractJsonArray(text: string): any[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not find JSON array in Gemini response");
  }
  const jsonStr = text.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

export async function generateWordQuestionsForStyle(
  env: Env,
  word: DbWord,
  style: QuestionStyle,
  count: number
): Promise<GeneratedWordQuestion[]> {
  const prompt = buildWordPrompt(word, style, count);
  const raw = await callGemini(env, prompt);

  let arr: any[];
  try {
    arr = extractJsonArray(raw);
  } catch (e) {
    console.error("Failed to parse Gemini JSON:", e, raw);
    throw new Error("Failed to parse Gemini JSON");
  }

  const questions: GeneratedWordQuestion[] = [];
  for (const item of arr) {
    if (
      !item ||
      typeof item.question_text !== "string" ||
      typeof item.option_a !== "string" ||
      typeof item.option_b !== "string" ||
      typeof item.option_c !== "string" ||
      typeof item.option_d !== "string" ||
      typeof item.correct_option !== "string"
    ) {
      continue;
    }
    const correct =
      item.correct_option.toUpperCase() as GeneratedWordQuestion["correct_option"];
    if (!["A", "B", "C", "D"].includes(correct)) continue;

    questions.push({
      question_text: item.question_text.trim(),
      option_a: item.option_a.trim(),
      option_b: item.option_b.trim(),
      option_c: item.option_c.trim(),
      option_d: item.option_d.trim(),
      correct_option: correct,
      explanation: (item.explanation || "").toString().trim()
    });
  }

  return questions;
}

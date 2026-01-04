// ⚠️ اسم فایل هنوز gemini.ts است تا هیچ جای دیگر پروژه نیاز به تغییر نداشته باشد.
// اما از این به بعد، این فایل با OpenAI (GPT) کار می‌کند.

import { Env } from "../types";

export interface WordQuestion {
  questionStyle: string;
  question: string;
  options: string[];
  correctOption: string;
  explanation: string;
}

export interface ReadingQuestion {
  question: string;
  options: string[];
  correctOption: string;
  explanation: string;
}

// -------------------------------
// Internal helpers
// -------------------------------

const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-nano";

function pickModel(env: Env): string {
  // اگر دوست داشتی بعداً مدل را تغییر دهی، می‌توانی در wrangler.toml یک VAR بسازی:
  // OPENAI_MODEL = "gpt-5-mini"  (یا gpt-5.2 / gpt-5.1 و ...)
  // ولی اگر نخواستی، همین پیش‌فرض gpt-5-nano است.
  return (env as any).OPENAI_MODEL || DEFAULT_MODEL;
}

function extractOutputText(resp: any): string {
  // بعضی SDKها output_text را می‌دهند، اما در fetch خام، باید از output آرایه بخوانیم
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  const out = resp?.output;
  if (!Array.isArray(out)) return "";

  for (const item of out) {
    if (item?.type !== "message") continue;
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "output_text" && typeof part?.text === "string") {
        return part.text;
      }
      // بعضی خروجی‌ها ممکن است این شکل باشند
      if (typeof part?.text === "string") return part.text;
    }
  }

  return "";
}

function cleanJsonText(s: string): string {
  const t = (s || "").trim();
  // حذف بک‌تیک‌ها اگر مدل داخل ```json ...``` داده باشد
  return t
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function callOpenAI(
  env: Env,
  args: {
    instructions: string;
    input: string;
    maxOutputTokens: number;
    schema?: any;
    jsonObject?: boolean;
  }
): Promise<any> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY تنظیم نشده. با wrangler secret put OPENAI_API_KEY ستش کن.");
  }

  const model = pickModel(env);

  const payload: any = {
    model,
    instructions: args.instructions,
    input: args.input,
    // برای ربات تلگرام بهتره ذخیره نشه
    store: false,
    // برای GPT-5-nano سرعت مهمه → effort پایین
    reasoning: { effort: "low" },
    max_output_tokens: args.maxOutputTokens,
    text: {
      verbosity: "low",
    },
  };

  if (args.schema) {
    // Structured Outputs (JSON Schema) — مطمئن‌تر از "فقط JSON بده"
    payload.text.format = {
      type: "json_schema",
      strict: true,
      schema: args.schema,
    };
  } else if (args.jsonObject) {
    // JSON mode (valid JSON ولی بدون چک کردن schema)
    payload.text.format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timeoutMs = 25_000;
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // اگر JSON نبود
    }

    if (!res.ok) {
      const msg = json?.error?.message || raw || `OpenAI error: ${res.status}`;
      throw new Error(msg);
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAIJson<T>(
  env: Env,
  args: {
    instructions: string;
    input: string;
    maxOutputTokens: number;
    schema: any;
  }
): Promise<T> {
  // تلاش 1: Structured Outputs
  try {
    const resp = await callOpenAI(env, args);
    const text = extractOutputText(resp);
    const cleaned = cleanJsonText(text);
    return JSON.parse(cleaned) as T;
  } catch (e: any) {
    // تلاش 2 (fallback): JSON mode (کمتر سختگیر) — اگر مدل/اکانت structured را ساپورت نکند
    const msg = String(e?.message || "");
    const shouldFallback =
      msg.includes("json_schema") ||
      msg.includes("text.format") ||
      msg.includes("format") ||
      msg.includes("schema");

    if (!shouldFallback) throw e;

    const fallbackPayloadResp = await callOpenAI(env, {
      instructions: `${args.instructions}\n\nIMPORTANT: پاسخ را فقط به صورت JSON بده.`,
      input: `${args.input}\n\nReturn ONLY valid JSON.`,
      maxOutputTokens: args.maxOutputTokens,
      jsonObject: true,
    });
    const text2 = extractOutputText(fallbackPayloadResp);
    const cleaned2 = cleanJsonText(text2);
    return JSON.parse(cleaned2) as T;
  }
}

// -------------------------------
// 1) Word questions (Leitner + Duel)
// -------------------------------

type WordQuestionStyle =
  | "fa_meaning"
  | "en_meaning"
  | "fill_blank"
  | "synonym"
  | "antonym"
  | "sentence"
  // استایل‌هایی که در پروژه شما استفاده می‌شوند:
  | "en_definition"
  | "word_from_definition";

interface GenerateWordQuestionsInput {
  env: Env;
  english: string;
  persian: string;
  level: number;
  questionStyle: WordQuestionStyle | string;
  count: number;
  // (اختیاری) اگر موجود باشد کیفیت synonym/antonym بهتر می‌شود
  synonyms?: string | null;
  antonyms?: string | null;
}

export async function generateWordQuestionsWithGemini(
  input: GenerateWordQuestionsInput
): Promise<
  {
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  }[]
> {
  const { env, english, persian, level, questionStyle, count, synonyms, antonyms } = input;

  const styleHelp: Record<string, string> = {
    fa_meaning:
      "Question is English word, options are 4 Persian meanings. Correct option is the exact Persian meaning.",
    en_meaning:
      "Question is English word, options are 4 English meanings/definitions. Correct is the best definition.",
    en_definition:
      "Question asks: 'Which definition matches <word>?' options are 4 short simple English definitions; exactly one correct.",
    word_from_definition:
      "Question is a short simple English definition; options are 4 English words; exactly one is the defined word.",
    fill_blank:
      "Question is a sentence with a blank (____) where the word fits; options are 4 English words.",
    synonym:
      "Question asks for closest synonym of the word; options are 4 English words.",
    antonym:
      "Question asks for closest antonym of the word; options are 4 English words.",
    sentence:
      "Question asks to choose the best sentence using the word correctly; options are 4 short sentences.",
  };

  const extraLex =
    (synonyms && synonyms.trim() ? `\nKnown synonyms from DB: ${synonyms}` : "") +
    (antonyms && antonyms.trim() ? `\nKnown antonyms from DB: ${antonyms}` : "");

  const prompt = `Generate ${count} multiple-choice question(s) for the following vocabulary item.

Word: ${english}
Persian meaning (ground truth): ${persian}
Difficulty level (1 easiest): ${level}
Requested style: ${questionStyle}
Style rule: ${styleHelp[String(questionStyle)] || "Follow the requested style."}
${extraLex}

Hard rules:
- Exactly 4 options.
- Exactly one correct option.
- Options must be distinct (no duplicates).
- Keep Persian options in Persian and English options in English.
- For fa_meaning: the correct option MUST be exactly the provided Persian meaning string (ground truth).
- Provide a short explanation.
`;

  const schema = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            questionStyle: {
              type: "string",
              enum: [
                "fa_meaning",
                "en_meaning",
                "en_definition",
                "word_from_definition",
                "fill_blank",
                "synonym",
                "antonym",
                "sentence",
              ],
            },
            question: { type: "string" },
            options: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "string" },
            },
            correctOption: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["questionStyle", "question", "options", "correctOption", "explanation"],
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };

  const data = await callOpenAIJson<{ questions: WordQuestion[] }>(env, {
    instructions:
      "You are a professional English vocabulary teacher. Create clean exam-style multiple choice questions.",
    input: prompt,
    maxOutputTokens: Math.min(1200, 250 + count * 220),
    schema,
  });

  const questions = (data?.questions || []).slice(0, count);

  // تبدیل به فرمت مورد نیاز پروژه
  return questions.map((q) => {
    const correctIndex = q.options.findIndex((opt) => opt === q.correctOption);
    return {
      question: q.question,
      options: q.options,
      correctIndex: correctIndex >= 0 ? correctIndex : 0,
      explanation: q.explanation,
    };
  });
}

// -------------------------------
// 2) Reading questions
// -------------------------------

interface GenerateReadingQuestionsInput {
  env: Env;
  text: string;
  count: number;
  level: number;
}

export async function generateReadingQuestionsWithGemini(
  input: GenerateReadingQuestionsInput
): Promise<
  {
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
  }[]
> {
  const { env, text, count, level } = input;

  const prompt = `Create ${count} reading comprehension multiple-choice question(s) based ONLY on the following passage.

PASSAGE:\n${text}\n\n
Rules:
- Each question must be answerable strictly from the passage.
- Exactly 4 options.
- Exactly one correct option.
- Provide a short explanation referencing the passage.
- Difficulty level: ${level} (1 easiest).
`;

  const schema = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            options: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "string" },
            },
            correctOption: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["question", "options", "correctOption", "explanation"],
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };

  const data = await callOpenAIJson<{ questions: ReadingQuestion[] }>(env, {
    instructions:
      "You are an expert English reading teacher. Generate high-quality reading comprehension questions.",
    input: prompt,
    maxOutputTokens: Math.min(1600, 300 + count * 260),
    schema,
  });

  const questions = (data?.questions || []).slice(0, count);

  return questions.map((q) => {
    const correctIndex = q.options.findIndex((opt) => opt === q.correctOption);
    return {
      question: q.question,
      options: q.options,
      correctIndex: correctIndex >= 0 ? correctIndex : 0,
      explanation: q.explanation,
    };
  });
}

// -------------------------------
// 3) Reflection paragraph
// -------------------------------

interface GenerateReflectionParagraphInput {
  env: Env;
  topic: string;
  level: number;
}

export async function generateReflectionParagraph(input: GenerateReflectionParagraphInput): Promise<string> {
  const { env, topic, level } = input;

  const prompt = `Write one English paragraph (80–120 words) suitable for ESL learners.
Topic: ${topic}
Difficulty: ${level} (1 easiest)

Rules:
- Clear, natural English.
- No markdown.
- One paragraph only.
`;

  const resp = await callOpenAI(env, {
    instructions: "You are a helpful ESL writing assistant.",
    input: prompt,
    maxOutputTokens: 350,
  });

  const out = extractOutputText(resp);
  return out.trim();
}

// -------------------------------
// 4) Evaluate reflection
// -------------------------------

interface EvaluateReflectionInput {
  env: Env;
  userAnswer: string;
  topic: string;
}

export async function evaluateReflection(input: EvaluateReflectionInput): Promise<{ score: number; feedback: string }> {
  const { env, userAnswer, topic } = input;

  const prompt = `You are grading an ESL learner's paragraph.
Topic: ${topic}

Student answer:\n${userAnswer}\n\n
Return JSON with:
- score: integer 0 to 10
- feedback: Persian feedback (helpful, short, and practical)
`;

  const schema = {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 10 },
      feedback: { type: "string" },
    },
    required: ["score", "feedback"],
    additionalProperties: false,
  };

  return await callOpenAIJson<{ score: number; feedback: string }>(env, {
    instructions:
      "You are a strict but kind ESL teacher. Always be fair. Give feedback in Persian.",
    input: prompt,
    maxOutputTokens: 260,
    schema,
  });
}

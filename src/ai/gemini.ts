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
  return (env as any).OPENAI_MODEL || DEFAULT_MODEL;
}

function extractOutputText(resp: any): string {
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
      if (typeof part?.text === "string") return part.text;
    }
  }

  return "";
}

function cleanJsonText(s: string): string {
  const t = (s || "").trim();
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
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: args.maxOutputTokens,
    text: { verbosity: "low" },
  };

  if (args.schema) {
    payload.text.format = {
      type: "json_schema",
      strict: true,
      schema: args.schema,
    };
  } else if (args.jsonObject) {
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
      // ignore
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
  try {
    const resp = await callOpenAI(env, args);
    const text = extractOutputText(resp);
    const cleaned = cleanJsonText(text);
    return JSON.parse(cleaned) as T;
  } catch (e: any) {
    const msg = String(e?.message || "");
    const shouldFallback =
      msg.includes("json_schema") ||
      msg.includes("text.format") ||
      msg.includes("format") ||
      msg.includes("schema");

    if (!shouldFallback) throw e;

    const fallbackResp = await callOpenAI(env, {
      instructions: `${args.instructions}\n\nIMPORTANT: پاسخ را فقط به صورت JSON بده.`,
      input: `${args.input}\n\nReturn ONLY valid JSON.`,
      maxOutputTokens: args.maxOutputTokens,
      jsonObject: true,
    });
    const text2 = extractOutputText(fallbackResp);
    const cleaned2 = cleanJsonText(text2);
    return JSON.parse(cleaned2) as T;
  }
}

// -------------------------------
// Quality guards for options
// -------------------------------

function normalizeForCompare(s: string): string {
  return (s || "")
    .replace(/\u200c/g, " ") // ZWNJ
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function uniqNormalized(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const n = normalizeForCompare(x);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(x.trim());
  }
  return out;
}

const FA_STOP = new Set(["و", "یا", "از", "به", "در", "برای", "با", "یک", "این", "آن", "کلی", "تا", "که"]);
const EN_STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "as"]);

function tokens(s: string, lang: "fa" | "en"): string[] {
  const base = normalizeForCompare(s)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return [];
  const raw = base.split(" ").filter(Boolean);
  const stop = lang === "fa" ? FA_STOP : EN_STOP;
  return raw.filter((t) => t.length >= 2 && !stop.has(t));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function hasExactDuplicate(options: string[]): boolean {
  const seen = new Set<string>();
  for (const o of options) {
    const n = normalizeForCompare(o);
    if (!n) return true;
    if (seen.has(n)) return true;
    seen.add(n);
  }
  return false;
}

function isTooSimilar(options: string[], lang: "fa" | "en"): boolean {
  // اگر دو گزینه خیلی overlap داشته باشن، یعنی نزدیک/شبیه‌اند
  const toks = options.map((o) => tokens(o, lang));
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      const sim = jaccard(toks[i], toks[j]);
      if (sim >= 0.6) return true;
    }
  }
  return false;
}

function sharesKeyTokensWithCorrect(correct: string, opt: string, lang: "fa" | "en"): boolean {
  const ct = tokens(correct, lang);
  const ot = tokens(opt, lang);
  if (!ct.length || !ot.length) return false;
  // اگر حداقل یک توکن کلیدی مشترک داشته باشند، در ترجمه فارسی معمولاً خیلی نزدیک می‌شود
  const cset = new Set(ct);
  for (const t of ot) if (cset.has(t)) return true;
  return false;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

// -------------------------------
// DB-based distractors for fa_meaning (BEST FIX)
// -------------------------------

async function fetchPersianCandidates(env: Env, english: string, level: number, limit: number): Promise<string[]> {
  // D1/SQLite supports ORDER BY RANDOM()
  const rows: string[] = [];

  // 1) same level
  try {
    const res = await env.DB
      .prepare(
        "SELECT persian FROM words WHERE is_active = 1 AND level = ? AND english <> ? ORDER BY RANDOM() LIMIT ?"
      )
      .bind(level, english, limit)
      .all();
    const list = (res?.results || []) as any[];
    for (const r of list) if (typeof r?.persian === "string") rows.push(r.persian);
  } catch {
    // ignore
  }

  // 2) nearby levels if still not enough
  if (rows.length < Math.min(limit, 12)) {
    const lvls = [level - 1, level + 1];
    for (const lvl of lvls) {
      if (lvl < 1) continue;
      try {
        const res = await env.DB
          .prepare(
            "SELECT persian FROM words WHERE is_active = 1 AND level = ? AND english <> ? ORDER BY RANDOM() LIMIT ?"
          )
          .bind(lvl, english, limit)
          .all();
        const list = (res?.results || []) as any[];
        for (const r of list) if (typeof r?.persian === "string") rows.push(r.persian);
      } catch {
        // ignore
      }
    }
  }

  // 3) any level fallback
  if (rows.length < 8) {
    try {
      const res = await env.DB
        .prepare("SELECT persian FROM words WHERE is_active = 1 AND english <> ? ORDER BY RANDOM() LIMIT ?")
        .bind(english, limit)
        .all();
      const list = (res?.results || []) as any[];
      for (const r of list) if (typeof r?.persian === "string") rows.push(r.persian);
    } catch {
      // ignore
    }
  }

  return uniqNormalized(rows);
}

function pickDistractorsFromCandidates(
  correct: string,
  candidates: string[],
  needed: number
): string[] {
  const out: string[] = [];
  const correctN = normalizeForCompare(correct);
  for (const cand of shuffle(candidates)) {
    if (out.length >= needed) break;
    const cN = normalizeForCompare(cand);
    if (!cN) continue;
    if (cN === correctN) continue;

    // avoid near duplicates / shared key tokens
    if (sharesKeyTokensWithCorrect(correct, cand, "fa")) continue;
    if (out.some((x) => sharesKeyTokensWithCorrect(x, cand, "fa"))) continue;
    out.push(cand.trim());
  }
  return out;
}

function faMeaningQuestionTemplate(english: string): string {
  const templates = [
    `What is the meaning of the word '${english}'?`,
    `What is the Persian meaning of the English word '${english}'?`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
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
  | "en_definition"
  | "word_from_definition";

interface GenerateWordQuestionsInput {
  env: Env;
  english: string;
  persian: string;
  level: number;
  questionStyle: WordQuestionStyle | string;
  count: number;
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

  // ✅ FIX اصلی: برای fa_meaning، گزینه‌های غلط را از دیتابیس می‌کشیم (نه از مدل)
  // نتیجه:
  // - تکراری نمی‌شود
  // - گزینه‌های غلط خیلی نزدیک/هم‌معنی نمی‌شوند
  // - همیشه فقط یکی درست است (همان ground truth)
  if (String(questionStyle) === "fa_meaning") {
    const candidates = await fetchPersianCandidates(env, english, level, 40);

    const out: {
      question: string;
      options: string[];
      correctIndex: number;
      explanation: string;
    }[] = [];

    for (let i = 0; i < Math.max(1, count); i++) {
      const distractors = pickDistractorsFromCandidates(persian, candidates, 3);

      // اگر دیتابیس خیلی خالی بود، با چند گزینه‌ی عمومی پر می‌کنیم
      const safeFallback = ["تعریف", "تصمیم", "احساس", "نتیجه", "پیشنهاد", "مشکل", "تجربه"];
      for (const fb of safeFallback) {
        if (distractors.length >= 3) break;
        if (normalizeForCompare(fb) === normalizeForCompare(persian)) continue;
        if (sharesKeyTokensWithCorrect(persian, fb, "fa")) continue;
        if (!distractors.some((x) => normalizeForCompare(x) === normalizeForCompare(fb))) {
          distractors.push(fb);
        }
      }

      const options = shuffle([persian, ...distractors.slice(0, 3)]);
      const correctIndex = options.findIndex((x) => normalizeForCompare(x) === normalizeForCompare(persian));

      out.push({
        question: faMeaningQuestionTemplate(english),
        options,
        correctIndex: correctIndex >= 0 ? correctIndex : 0,
        explanation: `'${english}' یعنی: ${persian}`,
      });
    }

    return out;
  }

  const styleHelp: Record<string, string> = {
    en_meaning:
      "Question is English word, options are 4 English meanings/definitions. Correct is the best definition.",
    en_definition:
      "Question asks: 'Which definition matches <word>?' options are 4 short simple English definitions; exactly one correct.",
    word_from_definition:
      "Question is a short simple English definition; options are 4 English words; exactly one is the defined word.",
    fill_blank:
      "Question is a sentence with a blank (____) where the word fits; options are 4 English words.",
    synonym:
      "Question asks for closest synonym of the word; options are 4 English words. Distractors must NOT be synonyms.",
    antonym:
      "Question asks for closest antonym of the word; options are 4 English words. Distractors must NOT be antonyms.",
    sentence:
      "Question asks to choose the best sentence using the word correctly; options are 4 short sentences.",
  };

  const extraLex =
    (synonyms && synonyms.trim() ? `\nKnown synonyms from DB: ${synonyms}` : "") +
    (antonyms && antonyms.trim() ? `\nKnown antonyms from DB: ${antonyms}` : "");

  const basePrompt = `Generate ${count} multiple-choice question(s) for the following vocabulary item.

Word: ${english}
Persian meaning (ground truth): ${persian}
Difficulty level (1 easiest): ${level}
Requested style: ${questionStyle}
Style rule: ${styleHelp[String(questionStyle)] || "Follow the requested style."}
${extraLex}

Hard rules (VERY IMPORTANT):
- Exactly 4 options.
- Exactly one correct option.
- Options must be UNIQUE (no duplicates) and NOT near-duplicates.
- Do NOT use slashes "/" or the word "or/یا" to list multiple meanings inside a single option.
- Each option must be short and clean (ideally <= 6 words).
- Distractors must be plausible but CLEARLY WRONG (not synonyms / not alternate correct answers).
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
              uniqueItems: true,
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

  // Retry loop: اگر گزینه‌ها تکراری/خیلی مشابه باشند، دوباره تولید می‌کنیم
  let lastBad: any = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}

The previous attempt was INVALID because options were duplicated or too similar, or distractors were ambiguous.
Avoid repeating any of these options:
${JSON.stringify(lastBad || {}, null, 2)}

Regenerate completely with clearly distinct distractors.`;

    const data = await callOpenAIJson<{ questions: WordQuestion[] }>(env, {
      instructions:
        "You are a professional English teacher. Create clean exam-style multiple choice questions with unambiguous distractors.",
      input: prompt,
      maxOutputTokens: Math.min(1400, 280 + count * 250),
      schema,
    });

    const questions = (data?.questions || []).slice(0, count);

    // validate
    let ok = true;
    for (const q of questions) {
      const opts = q.options || [];
      if (opts.length !== 4) ok = false;
      if (hasExactDuplicate(opts)) ok = false;

      const lang: "fa" | "en" = String(questionStyle) === "fa_meaning" ? "fa" : "en";
      // برای انگلیسی هم شباهت خیلی زیاد رو رد می‌کنیم
      if (isTooSimilar(opts, lang)) ok = false;

      // correct must be present
      const correctIdx = opts.findIndex((o) => normalizeForCompare(o) === normalizeForCompare(q.correctOption));
      if (correctIdx < 0) ok = false;

      // برای فارسی: گزینه‌های غلط نباید توکن کلیدی مشترک با گزینه درست داشته باشند
      if (lang === "fa") {
        for (const o of opts) {
          if (normalizeForCompare(o) === normalizeForCompare(q.correctOption)) continue;
          if (sharesKeyTokensWithCorrect(q.correctOption, o, "fa")) ok = false;
        }
      }
    }

    if (ok) {
      return questions.map((q) => {
        const correctIndex = q.options.findIndex(
          (opt) => normalizeForCompare(opt) === normalizeForCompare(q.correctOption)
        );
        return {
          question: q.question,
          options: q.options,
          correctIndex: correctIndex >= 0 ? correctIndex : 0,
          explanation: q.explanation,
        };
      });
    }

    lastBad = questions.map((q) => ({ question: q.question, options: q.options, correct: q.correctOption }));
  }

  // اگر بعد از ۳ تلاش هم خراب بود، همان تلاش آخر را برمی‌گردانیم (ولی معمولاً درست می‌شود)
  const fallback = await callOpenAIJson<{ questions: WordQuestion[] }>(env, {
    instructions:
      "You are a professional English teacher. Create clean multiple choice questions.",
    input: basePrompt,
    maxOutputTokens: Math.min(1400, 280 + count * 250),
    schema,
  });

  const questions = (fallback?.questions || []).slice(0, count);
  return questions.map((q) => {
    const correctIndex = q.options.findIndex(
      (opt) => normalizeForCompare(opt) === normalizeForCompare(q.correctOption)
    );
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

  const basePrompt = `Create ${count} reading comprehension multiple-choice question(s) based ONLY on the following passage.

PASSAGE:\n${text}\n\n
Rules (VERY IMPORTANT):
- Each question must be answerable strictly from the passage.
- Exactly 4 options.
- Exactly one correct option.
- Options must be UNIQUE (no duplicates) and not near-duplicates.
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
              uniqueItems: true,
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

  let lastBad: any = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}

Previous attempt had duplicated or too-similar options. Avoid these:
${JSON.stringify(lastBad || {}, null, 2)}
Regenerate all questions with clearly distinct options.`;

    const data = await callOpenAIJson<{ questions: ReadingQuestion[] }>(env, {
      instructions:
        "You are an expert English reading teacher. Generate high-quality reading comprehension questions.",
      input: prompt,
      maxOutputTokens: Math.min(1700, 320 + count * 280),
      schema,
    });

    const questions = (data?.questions || []).slice(0, count);

    let ok = true;
    for (const q of questions) {
      const opts = q.options || [];
      if (opts.length !== 4) ok = false;
      if (hasExactDuplicate(opts)) ok = false;
      if (isTooSimilar(opts, "en")) ok = false;
      const correctIdx = opts.findIndex((o) => normalizeForCompare(o) === normalizeForCompare(q.correctOption));
      if (correctIdx < 0) ok = false;
    }

    if (ok) {
      return questions.map((q) => {
        const correctIndex = q.options.findIndex(
          (opt) => normalizeForCompare(opt) === normalizeForCompare(q.correctOption)
        );
        return {
          question: q.question,
          options: q.options,
          correctIndex: correctIndex >= 0 ? correctIndex : 0,
          explanation: q.explanation,
        };
      });
    }

    lastBad = questions.map((q) => ({ question: q.question, options: q.options, correct: q.correctOption }));
  }

  const data = await callOpenAIJson<{ questions: ReadingQuestion[] }>(env, {
    instructions:
      "You are an expert English reading teacher. Generate questions.",
    input: basePrompt,
    maxOutputTokens: Math.min(1700, 320 + count * 280),
    schema,
  });

  const questions = (data?.questions || []).slice(0, count);

  return questions.map((q) => {
    const correctIndex = q.options.findIndex(
      (opt) => normalizeForCompare(opt) === normalizeForCompare(q.correctOption)
    );
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

export async function evaluateReflection(
  input: EvaluateReflectionInput
): Promise<{ score: number; feedback: string }> {
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
    instructions: "You are a strict but kind ESL teacher. Always be fair. Give feedback in Persian.",
    input: prompt,
    maxOutputTokens: 260,
    schema,
  });
}

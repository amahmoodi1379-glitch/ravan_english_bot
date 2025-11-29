import { Env } from "../types";
import { execute } from "./client";

export interface NewWordQuestionRow {
  wordId: number;
  questionText: string;
  options: string[]; // max 4
  correctIndex: number; // 0..3
  explanation: string;
  questionStyle: string;
}

// تابع کمکی برای بر هم زدن آرایه (Shuffle)
function shuffleArray<T>(array: T[]): T[] {
  // کپی گرفتن از آرایه برای جلوگیری از تغییر مرجع
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

export async function insertWordQuestions(
  env: Env,
  wordId: number,
  questions: NewWordQuestionRow[]
): Promise<void> {
  for (const q of questions) {
    // ۱. آماده‌سازی گزینه‌ها
    let opts = q.options.slice(0, 4);
    // اگر کمتر از ۴ گزینه بود با رشته خالی پر کن
    while (opts.length < 4) {
      opts.push("");
    }

    // ۲. پیدا کردن متنِ جواب درست (قبل از شافل کردن)
    // چون هوش مصنوعی ایندکس جواب رو میده، اول متنش رو پیدا می‌کنیم
    const originalCorrectIndex = (q.correctIndex >= 0 && q.correctIndex < opts.length) ? q.correctIndex : 0;
    const correctAnswerText = opts[originalCorrectIndex];

    // ۳. شافل کردن گزینه‌ها (تغییر ترتیب)
    // این کار باعث میشه جواب درست به یک جایگاه تصادفی بره
    const shuffledOpts = shuffleArray(opts);

    // ۴. پیدا کردن جایگاه جدید جواب درست
    const newCorrectIndex = shuffledOpts.indexOf(correctAnswerText);
    const correctLetter = ["A", "B", "C", "D"][newCorrectIndex];

    const [a, b, c, d] = shuffledOpts;

    // ۵. ذخیره در دیتابیس
    await execute(
      env,
      `
      INSERT INTO word_questions
        (word_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, question_style)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        wordId,
        q.questionText,
        a,
        b,
        c,
        d,
        correctLetter,
        q.explanation || null,
        q.questionStyle
      ]
    );
  }
}

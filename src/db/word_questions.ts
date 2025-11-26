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

export async function insertWordQuestions(
  env: Env,
  wordId: number,
  questions: NewWordQuestionRow[]
): Promise<void> {
  for (const q of questions) {
    const opts = q.options.slice(0, 4);
    while (opts.length < 4) {
      opts.push("");
    }
    const [a, b, c, d] = opts;

    const correctIndex =
      q.correctIndex >= 0 && q.correctIndex <= 3 ? q.correctIndex : 0;
    const correctLetter = ["A", "B", "C", "D"][correctIndex];

    await execute(
      env,
      `
      INSERT INTO word_questions
        (word_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, question_style)
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

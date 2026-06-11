import { Env } from "../types";
import { execute } from "./client";

export interface NewWordQuestionRow {
  wordId: number;
  questionText: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  questionStyle: string;
  source?: "manual" | "ai" | "seed";
}

function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

/**
 * Insert multiple-choice questions for a word, shuffling options before storage.
 * @param env - The worker environment containing the D1 database binding
 * @param wordId - The word ID to associate the questions with
 * @param questions - An array of question data rows to insert
 * @returns void
 */
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

    const originalCorrectIndex = (q.correctIndex >= 0 && q.correctIndex < opts.length) ? q.correctIndex : 0;
    const correctAnswerText = opts[originalCorrectIndex];

    const shuffledOpts = shuffleArray(opts);
    const newCorrectIndex = shuffledOpts.indexOf(correctAnswerText);
    const correctLetter = ["A", "B", "C", "D"][newCorrectIndex];

    const [a, b, c, d] = shuffledOpts;

    await execute(
      env,
      `
      INSERT INTO word_questions
        (word_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, question_style, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        q.questionStyle,
        q.source || "ai"
      ]
    );
  }
}

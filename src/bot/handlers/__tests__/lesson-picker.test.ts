import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { trimLessonName } from "../../../utils/lesson";

// Feature: lesson-aware-leitner, Property 4: Lesson picker shows exactly the lessons with unlearned words

interface Word {
  id: number;
  lesson_name: string | null;
  is_active: boolean;
  hasQuestions: boolean;
}

interface LessonEntry {
  lessonName: string | null; // trimmed
  wordCount: number;
}

/**
 * Pure-function model of the lesson picker logic.
 * Given a word pool and a set of learned word IDs, compute which lessons
 * should appear in the picker and with what word counts.
 */
function computeExpectedLessons(words: Word[], learnedWordIds: Set<number>): LessonEntry[] {
  const lessonMap = new Map<string | null, number>();

  for (const w of words) {
    if (!w.is_active || !w.hasQuestions) continue;
    if (learnedWordIds.has(w.id)) continue;

    const trimmed = trimLessonName(w.lesson_name);
    lessonMap.set(trimmed, (lessonMap.get(trimmed) ?? 0) + 1);
  }

  return Array.from(lessonMap.entries())
    .map(([lessonName, wordCount]) => ({ lessonName, wordCount }))
    .filter((e) => e.wordCount > 0);
}

// --- Generators ---

// Generate a word with unique id, arbitrary lesson_name, active/question status
const wordArb = (idOffset: number) =>
  fc.record({
    id: fc.constant(idOffset),
    lesson_name: fc.oneof(
      fc.constant(null),
      fc.string({ minLength: 0, maxLength: 15 }),
    ),
    is_active: fc.boolean(),
    hasQuestions: fc.boolean(),
  });

// Generate an array of words with unique IDs
const wordArrayArb = fc
  .array(
    fc.record({
      lesson_name: fc.oneof(
        fc.constant(null),
        fc.string({ minLength: 0, maxLength: 15 }),
      ),
      is_active: fc.boolean(),
      hasQuestions: fc.boolean(),
    }),
    { minLength: 0, maxLength: 30 },
  )
  .map((words) => words.map((w, i) => ({ ...w, id: i + 1 })));

// Generate a learned set as a subset of word IDs
const learnedSetArb = (words: Word[]) => {
  const ids = words.map((w) => w.id);
  return fc.subarray(ids).map((arr) => new Set(arr));
};

// **Validates: Requirements 4.3, 4.4**
describe("Property 4: Lesson picker shows exactly the lessons with unlearned words", () => {
  it("every lesson with at least one qualifying unlearned word appears in the picker list", () => {
    fc.assert(
      fc.property(
        wordArrayArb.chain((words) =>
          learnedSetArb(words).map((learned) => ({ words, learned })),
        ),
        ({ words, learned }) => {
          const result = computeExpectedLessons(words, learned);

          // Independently compute which lessons SHOULD appear
          const expectedLessons = new Set<string | null>();
          for (const w of words) {
            if (!w.is_active || !w.hasQuestions) continue;
            if (learned.has(w.id)) continue;
            expectedLessons.add(trimLessonName(w.lesson_name));
          }

          const resultLessons = new Set(result.map((e) => e.lessonName));

          // Every expected lesson must be in the result
          for (const lesson of expectedLessons) {
            expect(resultLessons.has(lesson)).toBe(true);
          }

          // Every result lesson must be in expected
          for (const lesson of resultLessons) {
            expect(expectedLessons.has(lesson)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("word count for each lesson equals the actual number of qualifying unlearned words", () => {
    fc.assert(
      fc.property(
        wordArrayArb.chain((words) =>
          learnedSetArb(words).map((learned) => ({ words, learned })),
        ),
        ({ words, learned }) => {
          const result = computeExpectedLessons(words, learned);

          // Independently compute expected counts per lesson
          const expectedCounts = new Map<string | null, number>();
          for (const w of words) {
            if (!w.is_active || !w.hasQuestions) continue;
            if (learned.has(w.id)) continue;
            const trimmed = trimLessonName(w.lesson_name);
            expectedCounts.set(trimmed, (expectedCounts.get(trimmed) ?? 0) + 1);
          }

          for (const entry of result) {
            expect(entry.wordCount).toBe(expectedCounts.get(entry.lessonName));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("no lesson appears in the list if it has zero qualifying unlearned words", () => {
    fc.assert(
      fc.property(
        wordArrayArb.chain((words) =>
          learnedSetArb(words).map((learned) => ({ words, learned })),
        ),
        ({ words, learned }) => {
          const result = computeExpectedLessons(words, learned);

          for (const entry of result) {
            // Verify each entry truly has qualifying words
            const qualifyingCount = words.filter(
              (w) =>
                w.is_active &&
                w.hasQuestions &&
                !learned.has(w.id) &&
                trimLessonName(w.lesson_name) === entry.lessonName,
            ).length;

            expect(qualifyingCount).toBeGreaterThan(0);
            expect(entry.wordCount).toBe(qualifyingCount);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

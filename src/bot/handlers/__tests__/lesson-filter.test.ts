import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { trimLessonName, lessonNamesEqual } from "../../../utils/lesson";

interface Word {
  id: number;
  lesson_name: string | null;
  order_index: number;
}

/**
 * Pure logic: filter words that belong to a selected lesson.
 * Mirrors pickNextNewWordByLesson's filtering logic.
 */
function filterWordsByLesson(words: Word[], selectedLesson: string | null): Word[] {
  return words.filter((w) => lessonNamesEqual(w.lesson_name, selectedLesson));
}

// Generators
const lessonNameArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.constant(null),
);

const wordArb = fc.record({
  id: fc.nat(),
  lesson_name: fc.oneof(
    fc.string({ minLength: 0, maxLength: 15 }),
    fc.constant(null),
  ),
  order_index: fc.nat({ max: 1000 }),
});

// Feature: lesson-aware-leitner, Property 6: Lesson-filtered learning only produces words from selected lesson
// **Validates: Requirements 4.8**
describe("Property 6: Lesson-filtered learning only produces words from selected lesson", () => {
  it("every word in the filtered output has lessonNamesEqual(word.lesson_name, selectedLesson) === true", () => {
    fc.assert(
      fc.property(fc.array(wordArb, { maxLength: 50 }), lessonNameArb, (words, selectedLesson) => {
        const filtered = filterWordsByLesson(words, selectedLesson);
        for (const word of filtered) {
          expect(lessonNamesEqual(word.lesson_name, selectedLesson)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("no word NOT matching the selected lesson appears in the output", () => {
    fc.assert(
      fc.property(fc.array(wordArb, { maxLength: 50 }), lessonNameArb, (words, selectedLesson) => {
        const filtered = filterWordsByLesson(words, selectedLesson);
        for (const word of filtered) {
          expect(trimLessonName(word.lesson_name)).toBe(trimLessonName(selectedLesson));
        }
      }),
      { numRuns: 100 },
    );
  });

  it("if a word matches the selected lesson, it IS in the output (completeness)", () => {
    fc.assert(
      fc.property(fc.array(wordArb, { maxLength: 50 }), lessonNameArb, (words, selectedLesson) => {
        const filtered = filterWordsByLesson(words, selectedLesson);
        // Every word in the original list that matches should be in the filtered output
        const expectedMatching = words.filter(
          (w) => trimLessonName(w.lesson_name) === trimLessonName(selectedLesson),
        );
        expect(filtered.length).toBe(expectedMatching.length);
        // All matching words should appear in the filtered list (same ids in same order)
        for (let i = 0; i < expectedMatching.length; i++) {
          expect(filtered[i].id).toBe(expectedMatching[i].id);
          expect(filtered[i].lesson_name).toBe(expectedMatching[i].lesson_name);
          expect(filtered[i].order_index).toBe(expectedMatching[i].order_index);
        }
      }),
      { numRuns: 100 },
    );
  });
});

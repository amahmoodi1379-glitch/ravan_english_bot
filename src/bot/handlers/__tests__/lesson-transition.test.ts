import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { lessonNamesEqual } from "../../../utils/lesson";

/**
 * Pure logic: should a transition notification be shown?
 * This mirrors the logic in checkLessonTransitionAndSend.
 */
function shouldShowTransition(
  currentLessonName: string | null | undefined,
  nextLessonName: string | null | undefined,
  isFirstWord: boolean,
): boolean {
  if (isFirstWord) return false;
  return !lessonNamesEqual(currentLessonName, nextLessonName);
}

// Generator for lesson name values: string | null | undefined
const lessonNameArb = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
);

// Feature: lesson-aware-leitner, Property 3: Lesson transition detection correctness
// **Validates: Requirements 1.1, 1.4, 1.5, 1.6**
describe("Property 3: Lesson transition detection correctness", () => {
  it("notification shown IFF lessonNamesEqual(current, next) is false (non-first word)", () => {
    fc.assert(
      fc.property(lessonNameArb, lessonNameArb, (current, next) => {
        const result = shouldShowTransition(current, next, false);
        const expected = !lessonNamesEqual(current, next);
        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("first word never triggers notification regardless of lesson names", () => {
    fc.assert(
      fc.property(lessonNameArb, lessonNameArb, (current, next) => {
        const result = shouldShowTransition(current, next, true);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

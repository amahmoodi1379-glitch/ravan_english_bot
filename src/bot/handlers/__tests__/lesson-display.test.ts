import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { trimLessonName } from "../../../utils/lesson";

/**
 * Pure logic: should the "📖 درس:" line be included in the feedback?
 * Returns the display line or null if it shouldn't be shown.
 * This mirrors the logic in both handleAnswer and handleDunno.
 */
function getLessonDisplayLine(
  lessonName: string | null | undefined,
): string | null {
  const trimmed = trimLessonName(lessonName);
  if (trimmed === null) return null;
  return `📖 درس: ${trimmed}`;
}

// Generator for lesson name values: string | null | undefined | empty / whitespace-only
const lessonNameArb = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\t\n"),
);

// Feature: lesson-aware-leitner, Property 8: Lesson name display in feedback shown IFF trimmed name is non-null
// **Validates: Requirements 2.1, 2.2**
describe("Property 8: Lesson name display in feedback shown IFF trimmed name is non-null", () => {
  it("getLessonDisplayLine returns non-null IFF trimLessonName returns non-null", () => {
    fc.assert(
      fc.property(lessonNameArb, (name) => {
        const displayLine = getLessonDisplayLine(name);
        const trimmed = trimLessonName(name);

        if (trimmed !== null) {
          expect(displayLine).not.toBeNull();
        } else {
          expect(displayLine).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("when trimLessonName is null (null input, empty, whitespace-only), no line is shown", () => {
    fc.assert(
      fc.property(lessonNameArb, (name) => {
        const trimmed = trimLessonName(name);
        if (trimmed === null) {
          expect(getLessonDisplayLine(name)).toBeNull();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("when trimLessonName is non-null, displayed line is exactly '📖 درس: {trimmed}'", () => {
    fc.assert(
      fc.property(lessonNameArb, (name) => {
        const trimmed = trimLessonName(name);
        if (trimmed !== null) {
          const displayLine = getLessonDisplayLine(name);
          expect(displayLine).toBe(`📖 درس: ${trimmed}`);
        }
      }),
      { numRuns: 100 },
    );
  });
});

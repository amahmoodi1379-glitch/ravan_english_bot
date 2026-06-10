import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { trimLessonName, lessonNamesEqual } from "../lesson";

// Generator for lesson name values: string | null | undefined
const lessonNameArb = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
);

// Feature: lesson-aware-leitner, Property 1: Trim normalization is idempotent and only removes edge whitespace
// **Validates: Requirements 3.1, 3.2, 3.4**
describe("Property 1: trimLessonName idempotence and edge-only whitespace removal", () => {
  it("applying trimLessonName twice produces the same result as applying it once (idempotence)", () => {
    fc.assert(
      fc.property(lessonNameArb, (input) => {
        const once = trimLessonName(input);
        const twice = trimLessonName(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it("result has no leading or trailing whitespace", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = trimLessonName(input);
        if (result !== null) {
          expect(result).toBe(result.trim());
        }
      }),
      { numRuns: 100 },
    );
  });

  it("internal whitespace is preserved unchanged", () => {
    // Generate strings with known internal whitespace between non-ws content
    const wsCharArb = fc.constantFrom(" ", "\t");
    const wsStringArb = fc.array(wsCharArb, { minLength: 1, maxLength: 5 }).map((a) => a.join(""));
    // Non-whitespace word (at least 1 char, no leading/trailing ws)
    const wordArb = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim() === s && s.length > 0);

    const arbWithInternal = fc
      .tuple(wordArb, wsStringArb, wordArb)
      .map(([prefix, middle, suffix]) => ({
        full: prefix + middle + suffix,
        internal: middle,
      }));

    fc.assert(
      fc.property(arbWithInternal, ({ full, internal }) => {
        const result = trimLessonName(full);
        // The result should contain the internal whitespace unchanged
        expect(result).toContain(internal);
        // The result should equal the input since prefix/suffix have no edge whitespace
        expect(result).toBe(full);
      }),
      { numRuns: 100 },
    );
  });

  it("null and undefined inputs return null", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.constant(undefined)), (input) => {
        expect(trimLessonName(input)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("whitespace-only strings return null", () => {
    const wsCharArb = fc.constantFrom(" ", "\t", "\n", "\r");
    const arbWhitespaceOnly = fc.array(wsCharArb, { minLength: 1, maxLength: 20 }).map((a) => a.join(""));
    fc.assert(
      fc.property(arbWhitespaceOnly, (input) => {
        expect(trimLessonName(input)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: lesson-aware-leitner, Property 2: Lesson name equality is symmetric and consistent with trim
// **Validates: Requirements 3.1, 1.6**
describe("Property 2: lessonNamesEqual symmetry and consistency with trim", () => {
  it("symmetry: lessonNamesEqual(a, b) === lessonNamesEqual(b, a) for all pairs", () => {
    fc.assert(
      fc.property(lessonNameArb, lessonNameArb, (a, b) => {
        expect(lessonNamesEqual(a, b)).toBe(lessonNamesEqual(b, a));
      }),
      { numRuns: 100 },
    );
  });

  it("consistency with trim: lessonNamesEqual(a, b) iff trimLessonName(a) === trimLessonName(b)", () => {
    fc.assert(
      fc.property(lessonNameArb, lessonNameArb, (a, b) => {
        const trimA = trimLessonName(a);
        const trimB = trimLessonName(b);
        const expectedEqual = trimA === trimB;
        expect(lessonNamesEqual(a, b)).toBe(expectedEqual);
      }),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { trimLessonName } from "../../../utils/lesson";

// Feature: lesson-aware-leitner, Property 5: Lesson picker deduplicates trimmed lesson names
// **Validates: Requirements 3.3**

interface Word {
  id: number;
  lesson_name: string | null;
}

/** Compute deduplicated lesson entries from a word list. */
function deduplicateLessons(words: Word[]): Map<string | null, number> {
  const lessonMap = new Map<string | null, number>();
  for (const w of words) {
    const trimmed = trimLessonName(w.lesson_name);
    lessonMap.set(trimmed, (lessonMap.get(trimmed) ?? 0) + 1);
  }
  return lessonMap;
}

// Generators
const wsArb = fc
  .array(fc.constantFrom(" ", "\t"), { minLength: 0, maxLength: 3 })
  .map((arr) => arr.join(""));

const baseLessonArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
  fc.constant(null),
);

const lessonWithWsArb = fc
  .tuple(baseLessonArb, wsArb, wsArb)
  .map(([base, pre, suf]) => (base === null ? null : pre + base + suf));

const wordArb = fc.tuple(fc.nat(), lessonWithWsArb).map(
  ([id, lesson_name]): Word => ({ id, lesson_name }),
);

const wordListArb = fc.array(wordArb, { minLength: 1, maxLength: 50 });

describe("Property 5: Lesson picker deduplicates trimmed lesson names", () => {
  it("no duplicate trimmed keys exist in deduplication output", () => {
    fc.assert(
      fc.property(wordListArb, (words) => {
        const result = deduplicateLessons(words);

        // A Map by definition has unique keys, but verify trimming produces unique entries:
        // Collect all trimmed lesson names from words and verify they map to exactly the keys in result
        const expectedKeys = new Set<string | null>();
        for (const w of words) {
          expectedKeys.add(trimLessonName(w.lesson_name));
        }
        expect(result.size).toBe(expectedKeys.size);
      }),
      { numRuns: 100 },
    );
  });

  it("words with lesson names differing only by whitespace are counted under the same key", () => {
    // Generate a base lesson name and multiple whitespace variants of it
    const baseNameArb = fc
      .string({ minLength: 1, maxLength: 15 })
      .filter((s) => s.trim().length > 0 && s.trim() === s);

    const variantCountArb = fc.integer({ min: 2, max: 10 });

    fc.assert(
      fc.property(baseNameArb, variantCountArb, wsArb, wsArb, (baseName, count, ws1, ws2) => {
        // Create multiple words with the same logical lesson but different whitespace
        const words: Word[] = [];
        for (let i = 0; i < count; i++) {
          // Each word gets a different whitespace prefix/suffix combination
          const prefix = " ".repeat(i % 3);
          const suffix = "\t".repeat(i % 2);
          words.push({ id: i, lesson_name: prefix + baseName + suffix });
        }

        const result = deduplicateLessons(words);

        // All should map to a single entry
        expect(result.size).toBe(1);
        expect(result.has(baseName)).toBe(true);
        expect(result.get(baseName)).toBe(count);
      }),
      { numRuns: 100 },
    );
  });

  it("total count across all entries equals total number of words", () => {
    fc.assert(
      fc.property(wordListArb, (words) => {
        const result = deduplicateLessons(words);

        let totalCount = 0;
        for (const count of result.values()) {
          totalCount += count;
        }

        expect(totalCount).toBe(words.length);
      }),
      { numRuns: 100 },
    );
  });

  it("mixed whitespace variants of the same lesson produce exactly one entry", () => {
    // Specifically generate words where the SAME logical lesson appears with different
    // whitespace variants (e.g., "lesson 1", "  lesson 1", "lesson 1  ")
    const baseNameArb = fc
      .string({ minLength: 1, maxLength: 10 })
      .filter((s) => s.trim().length > 0 && s.trim() === s);

    const wsVariantsArb = fc.array(
      fc.tuple(wsArb, wsArb),
      { minLength: 2, maxLength: 8 },
    );

    fc.assert(
      fc.property(baseNameArb, wsVariantsArb, (baseName, variants) => {
        const words: Word[] = variants.map(([pre, suf], i) => ({
          id: i,
          lesson_name: pre + baseName + suf,
        }));

        const result = deduplicateLessons(words);

        // Should have exactly one entry with the trimmed base name
        expect(result.size).toBe(1);
        expect(result.has(baseName)).toBe(true);
        expect(result.get(baseName)).toBe(words.length);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Lesson name normalization utilities.
 *
 * These functions handle trimming and comparison of lesson names
 * without modifying stored DB values (Requirement 3.5).
 */

/**
 * Trim whitespace from lesson name.
 * Returns null if input is null, undefined, or empty after trim.
 * Internal whitespace (between words) is preserved unchanged.
 * @param name - The lesson name string (or null/undefined)
 * @returns The trimmed lesson name, or null if empty/missing
 */
export function trimLessonName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Compare two lesson names after trimming (case-sensitive).
 * Both null (or empty-after-trim) values are considered equal.
 * Comparison is symmetric: lessonNamesEqual(a, b) === lessonNamesEqual(b, a).
 * @param a - The first lesson name to compare
 * @param b - The second lesson name to compare
 * @returns True if both names are equal after trimming
 */
export function lessonNamesEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ta = trimLessonName(a);
  const tb = trimLessonName(b);
  return ta === tb;
}

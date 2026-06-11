/**
 * Convert a multiple-choice option letter (A–D) to its numeric equivalent (1–4).
 * @param letter - The uppercase letter representing an option ("A", "B", "C", or "D")
 * @returns The corresponding number as a string, or empty string if invalid
 */
export function optionLetterToNumber(letter: string): string {
  switch (letter) {
    case "A": return "1";
    case "B": return "2";
    case "C": return "3";
    case "D": return "4";
    default: return "";
  }
}

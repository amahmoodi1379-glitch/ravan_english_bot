import { Env } from "../../../types";
import { InlineKeyboardButton } from "../../types";
import { editMessageReplyMarkup } from "../../telegram-api";
import {
  CB_PREFIX,
  LEITNER_TEST_TYPE_ORDER,
  LEITNER_TEST_TYPES,
  LeitnerTestType,
} from "../../../config/constants";

// --- Types ---

export interface LeitnerQuestionRow {
  id: number;
  word_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_style: string;
  explanation_text: string | null;
  english: string;
  persian: string;
  level: number;
  lesson_name: string | null;
}

export type ReviewMode = "review" | "new" | "leech" | "new1" | "new2" | "new3" | "new4" | "review1" | "review2" | "review3" | "review4" | `newL:${number}`;

// --- Mode-parsing functions ---

/**
 * Check if a string is a valid ReviewMode value.
 * @param m - The string to validate
 * @returns True if the string is a recognized ReviewMode
 */
export function isReviewMode(m: string): m is ReviewMode {
  return ["review", "new", "leech", "new1", "new2", "new3", "new4", "review1", "review2", "review3", "review4"].includes(m)
    || m.startsWith("newL:");
}

/**
 * Parse a raw string into a ReviewMode, defaulting to "review" if unrecognized.
 * @param raw - The raw mode string from a callback data payload
 * @returns A valid ReviewMode value
 */
export function parseMode(raw: string | undefined): ReviewMode {
  if (!raw) return "review";
  if (isReviewMode(raw)) return raw as ReviewMode;
  return "review";
}

/**
 * Extract mode from parts array starting at `fromIndex` and joining the rest
 * with ":". This handles modes that themselves contain colons (e.g. "newL:5").
 * @param parts - The callback data parts split by ":"
 * @param fromIndex - The index to start joining from
 * @returns A valid ReviewMode parsed from the joined parts
 */
export function extractMode(parts: string[], fromIndex: number): ReviewMode {
  return parseMode(parts.slice(fromIndex).join(":"));
}

/**
 * Extract the numeric level suffix from a mode string (e.g., "new3" → 3).
 * @param mode - The ReviewMode to extract the level from
 * @returns The level number, or undefined if the mode has no level suffix
 */
export function getLevelFromMode(mode: ReviewMode): number | undefined {
  const match = mode.match(/\d$/);
  return match ? parseInt(match[0], 10) : undefined;
}

/**
 * Check whether the mode represents a new-word learning session.
 * @param mode - The ReviewMode to check
 * @returns True if the mode starts with "new"
 */
export function isNewMode(mode: ReviewMode): boolean {
  return mode === "new" || mode.startsWith("new");
}

/**
 * Returns true if the mode is a lesson-filtered new-word mode (e.g., "newL:123").
 * @param mode - The ReviewMode to check
 * @returns True if the mode starts with "newL:"
 */
export function isLessonMode(mode: ReviewMode): boolean {
  return mode.startsWith("newL:");
}

/**
 * Extract lesson_id from a lesson-filtered mode like "newL:123".
 * @param mode - The ReviewMode to extract the lesson ID from
 * @returns The lesson ID number, or undefined if not a lesson mode
 */
export function getLessonIdFromMode(mode: ReviewMode): number | undefined {
  if (!mode.startsWith("newL:")) return undefined;
  const id = parseInt(mode.slice(5), 10);
  return isNaN(id) ? undefined : id;
}

/**
 * Check if the mode is a review-type session (review, review1, review2, etc.).
 * @param mode - The ReviewMode to check
 * @returns True if the mode represents a review session
 */
export function isReviewModeType(mode: ReviewMode): boolean {
  return mode === "review" || mode.startsWith("review");
}

// --- Button builders (single source of truth) ---

/**
 * Get the localized exit button label text for the given mode.
 * @param mode - The current ReviewMode
 * @returns A Persian string for the exit button text
 */
export function exitButtonText(mode: ReviewMode): string {
  if (isNewMode(mode)) return "🚪 پایان یادگیری";
  if (mode === "leech") return "🚪 پایان تمرین";
  return "🚪 پایان مرور";
}

/**
 * Get the localized exit confirmation prompt text for the given mode.
 * @param mode - The current ReviewMode
 * @returns A Persian string for the exit confirmation prompt
 */
export function exitConfirmText(mode: ReviewMode): string {
  if (isNewMode(mode)) return "مطمئنی میخوای از یادگیری واژه‌های جدید خارج بشی؟";
  if (mode === "leech") return "مطمئنی میخوای از تمرین واژه‌های سخت خارج بشی؟";
  return "مطمئنی میخوای از مرور خارج بشی؟";
}

/**
 * Create the "next question" inline keyboard button.
 * @param mode - The current ReviewMode for callback data
 * @returns An InlineKeyboardButton configured for the next question action
 */
export function nextButton(mode: ReviewMode): InlineKeyboardButton {
  return { text: "⚡ سوال بعدی", callback_data: `${CB_PREFIX.LEITNER_NEXT}:${mode}`, style: "primary" };
}

/**
 * Create the "exit session" inline keyboard button.
 * @param mode - The current ReviewMode for callback data and label
 * @returns An InlineKeyboardButton configured for the exit action
 */
export function exitButton(mode: ReviewMode): InlineKeyboardButton {
  return { text: exitButtonText(mode), callback_data: `${CB_PREFIX.LEITNER_EXIT}:${mode}`, style: "danger" };
}

/**
 * Create the "ignore word" inline keyboard button.
 * @param questionId - The ID of the current question
 * @param mode - The current ReviewMode for callback data
 * @returns An InlineKeyboardButton configured for the ignore word action
 */
export function ignoreButton(questionId: number, mode: ReviewMode): InlineKeyboardButton {
  return { text: "🗑 نشونم نده", callback_data: `${CB_PREFIX.LEITNER_IGNORE}:${questionId}:${mode}` };
}

/**
 * Create the "unleech" inline keyboard button (remove from hard words list).
 * @param questionId - The ID of the current question
 * @param mode - The current ReviewMode for callback data
 * @returns An InlineKeyboardButton configured for the unleech action
 */
export function unleechButton(questionId: number, mode: ReviewMode): InlineKeyboardButton {
  return { text: "🎓 یادش گرفتم!", callback_data: `${CB_PREFIX.LEITNER_UNLEECH}:${questionId}:${mode}`, style: "success" };
}

/**
 * Create the "report question" inline keyboard button (flag a buggy test).
 * @param questionId - The ID of the current question
 * @returns An InlineKeyboardButton configured to start the report-confirm flow
 */
export function reportButton(questionId: number): InlineKeyboardButton {
  return { text: "🚩 گزارش سوال", callback_data: `${CB_PREFIX.LEITNER_REPORT}:${questionId}` };
}

/**
 * Create the "home" inline keyboard button for returning to the leitner menu.
 * @returns An InlineKeyboardButton configured for the home/menu action
 */
export function homeButton(): InlineKeyboardButton {
  return { text: "🏠 بازگشت به منو", callback_data: `${CB_PREFIX.LEITNER_HOME}:1` };
}

/**
 * Footer rows shown after the word has been processed (next + exit).
 * @param mode - The current ReviewMode for button callback data
 * @returns A 2D array of InlineKeyboardButtons (next row + exit row)
 */
export function nextAndExitRows(mode: ReviewMode): InlineKeyboardButton[][] {
  return [[nextButton(mode)], [exitButton(mode)]];
}

// --- Stage / Question Type Logic ---

export const TEST_TYPE_STAGE: Record<LeitnerTestType, number> = {
  [LEITNER_TEST_TYPES.EN_TO_FA]: 1,
  [LEITNER_TEST_TYPES.FA_TO_EN]: 2,
  [LEITNER_TEST_TYPES.DEFINITION_TO_WORD]: 3,
  [LEITNER_TEST_TYPES.WORD_TO_DEFINITION]: 4,
  [LEITNER_TEST_TYPES.CLOZE]: 5,
};

export const TEST_TYPE_STYLE_ALIASES: Record<LeitnerTestType, string[]> = {
  [LEITNER_TEST_TYPES.EN_TO_FA]: ["en_to_fa", "fa_meaning"],
  [LEITNER_TEST_TYPES.FA_TO_EN]: ["fa_to_en", "en_meaning"],
  [LEITNER_TEST_TYPES.DEFINITION_TO_WORD]: ["definition_to_word", "word_from_definition"],
  [LEITNER_TEST_TYPES.WORD_TO_DEFINITION]: ["word_to_definition", "en_definition"],
  [LEITNER_TEST_TYPES.CLOZE]: ["cloze", "fill_blank"],
};

/**
 * Get the allowed question styles for a given word stage (progressive unlock).
 * @param stage - The word's current learning stage (1–5)
 * @returns An array of LeitnerTestType values available at the given stage
 */
export function getQuestionStyleForStage(stage: number): LeitnerTestType[] {
  const normalizedStage = Math.max(1, Math.min(5, stage || 1));
  return LEITNER_TEST_TYPE_ORDER.filter((testType) => TEST_TYPE_STAGE[testType] <= normalizedStage);
}

/**
 * Get the question_style DB column aliases for a given test type.
 * @param testType - The canonical LeitnerTestType
 * @returns An array of style alias strings matching this test type in the DB
 */
export function getStylesForType(testType: LeitnerTestType): string[] {
  return TEST_TYPE_STYLE_ALIASES[testType] || [];
}

// --- Small helpers ---

/**
 * Get the text of the correct answer option from a question row.
 * @param q - The question row containing options and the correct_option letter
 * @returns The text of the correct option (A/B/C/D)
 */
export function getCorrectOptionText(q: LeitnerQuestionRow): string {
  switch (q.correct_option) {
    case "A": return q.option_a;
    case "B": return q.option_b;
    case "C": return q.option_c;
    case "D": return q.option_d;
    default: return "";
  }
}

/**
 * Remove an inline keyboard from a previous message (preserves its text).
 * @param env - The worker environment containing the bot token
 * @param chatId - The chat ID containing the message
 * @param messageId - The ID of the message to clear the keyboard from
 * @returns void
 */
export async function removeInlineKeyboard(env: Env, chatId: number, messageId: number): Promise<void> {
  try {
    await editMessageReplyMarkup(env, chatId, messageId);
  } catch {
    // Ignore — message may be too old or already edited.
  }
}

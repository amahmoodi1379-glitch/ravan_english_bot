export const PRIMARY_WORD_STYLE_ORDER = [
  "en_to_fa",
  "fa_to_en",
  "definition_to_word",
  "word_to_definition",
  "cloze",
] as const;

const LEGACY_WORD_STYLE_ORDER = [
  "fa_meaning",
  "en_meaning",
  "word_from_definition",
  "en_definition",
  "fill_blank",
  "synonym",
  "antonym",
] as const;

const PRIMARY_TEXT_TYPE_ORDER = [
  "main_idea",
  "detail",
  "inference",
  "vocabulary_in_context",
  "title",
] as const;

const LEGACY_TEXT_TYPE_ORDER = [
  "reading",
] as const;

function buildPriorityCase(columnName: string, orderedValues: readonly string[], fallbackPriority: number): string {
  const cases = orderedValues.map((value, idx) => `WHEN '${value}' THEN ${idx + 1}`).join(" ");
  return `CASE ${columnName} ${cases} ELSE ${fallbackPriority} END`;
}

export function getWordStylePrioritySql(columnName: string = "q.question_style"): string {
  const ordered = [...PRIMARY_WORD_STYLE_ORDER, ...LEGACY_WORD_STYLE_ORDER];
  return buildPriorityCase(columnName, ordered, 999);
}

export function getTextQuestionTypePrioritySql(columnName: string = "q.question_type"): string {
  const ordered = [...PRIMARY_TEXT_TYPE_ORDER, ...LEGACY_TEXT_TYPE_ORDER];
  return buildPriorityCase(columnName, ordered, 999);
}

# Implementation Plan: Lesson-Aware Leitner

## Overview

This plan implements lesson-awareness in the Leitner vocabulary system. It proceeds bottom-up: utility functions first, then DB queries, then constants, then handler modifications. Property-based tests validate the pure utility functions, while unit/integration tests cover the handler logic.

## Tasks

- [x] 1. Create lesson utility module and constants
  - [x] 1.1 Create `src/utils/lesson.ts` with `trimLessonName` and `lessonNamesEqual`
    - Implement `trimLessonName(name: string | null | undefined): string | null` — trims whitespace, returns null if input is null/undefined/empty-after-trim
    - Implement `lessonNamesEqual(a: string | null | undefined, b: string | null | undefined): boolean` — symmetric comparison using trimmed values, both-null is equal
    - Export both functions
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [x] 1.2 Add new callback prefixes and constants to `src/config/constants.ts`
    - Add `LEITNER_LESSON_PICK: "llp"` to `CB_PREFIX`
    - Add `LEITNER_LESSON_CONT: "llc"` to `CB_PREFIX`
    - Add `LEITNER_LESSON_STOP: "lls"` to `CB_PREFIX`
    - Add `export const LESSON_PICKER_PAGE_SIZE = 20;`
    - _Requirements: 4.9, 4.5_

  - [x] 1.3 Write property tests for `trimLessonName` (Property 1)
    - **Property 1: Trim normalization is idempotent and only removes edge whitespace**
    - Install `vitest` and `fast-check` as devDependencies
    - Create test file `src/utils/__tests__/lesson.test.ts`
    - Test: `trimLessonName(trimLessonName(x)) === trimLessonName(x)` for arbitrary strings
    - Test: result has no leading/trailing whitespace
    - Test: internal whitespace is preserved unchanged
    - Minimum 100 iterations
    - **Validates: Requirements 3.1, 3.2, 3.4**

  - [x] 1.4 Write property tests for `lessonNamesEqual` (Property 2)
    - **Property 2: Lesson name equality is symmetric and consistent with trim**
    - Test: `lessonNamesEqual(a, b) === lessonNamesEqual(b, a)` for arbitrary pairs
    - Test: `lessonNamesEqual(a, b)` iff `trimLessonName(a) === trimLessonName(b)`
    - Minimum 100 iterations
    - **Validates: Requirements 3.1, 1.6**

- [x] 2. Implement lesson-aware DB queries
  - [x] 2.1 Add `getUnlearnedLessons` to `src/db/leitner.ts`
    - Query distinct trimmed `lesson_name` from `words` where is_active=1 and word not in `user_words_sm2` for user
    - Include word count per lesson and min `order_index` for sorting
    - Group by trimmed lesson name (use `TRIM(lesson_name)` in SQL)
    - Order by `min_order` ascending, null lessons last
    - Optional `level` filter parameter
    - _Requirements: 4.2, 4.3, 4.4, 4.10, 3.3_

  - [x] 2.2 Add `countNewWordsByLesson` to `src/db/leitner.ts`
    - Count new words for a specific trimmed lesson name (supports null for "no lesson" group)
    - Used to validate lesson has words before starting
    - _Requirements: 4.11_

  - [x] 2.3 Add `pickNextNewWordByLesson` to `src/db/leitner.ts`
    - Similar to existing `pickNextNewWord` but filtered by lesson name (trimmed comparison)
    - Preserves homograph-skipping logic from existing function
    - Orders by `order_index ASC, id ASC`
    - _Requirements: 4.8_

  - [x] 2.4 Add `peekNextNewWord` to `src/db/leitner.ts`
    - Read-only query to get the next new word without side effects
    - Supports optional `level` and `lessonName` filter
    - Used for lesson transition detection
    - _Requirements: 1.1, 1.4, 1.5_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Modify handler for lesson-filtered learning mode
  - [x] 4.1 Extend `ReviewMode` type and parsing in `src/bot/handlers/leitner.ts`
    - Add `newL` prefix pattern for lesson-filtered modes (e.g., `newL:5`)
    - Update `isReviewMode`, `parseMode`, `isNewMode` to recognize lesson modes
    - Add helper to extract lesson offset from mode string
    - _Requirements: 4.9_

  - [x] 4.2 Add `handleLessonPicker` function to `src/bot/handlers/leitner.ts`
    - Parse `llp:{page}` for pagination and `llp:s:{offset}` for lesson selection
    - Fetch unlearned lessons via `getUnlearnedLessons`
    - Apply pagination (page size from `LESSON_PICKER_PAGE_SIZE`)
    - Build inline keyboard: one button per lesson showing `"{name} ({count})"`, callback `llp:s:{offset}`
    - Add prev/next page buttons per requirements 4.5, 4.6, 4.7
    - On lesson selection: validate lesson has words, start lesson-filtered learning
    - Show "بدون درس" for null lesson names
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

  - [x] 4.3 Modify `handleNewLevel` to add lesson picker button
    - Add "📖 انتخاب بر اساس درس" button with callback `llp:0` in the level selection menu
    - _Requirements: 4.1_

  - [x] 4.4 Implement lesson transition detection in the question flow
    - After answering in new-word mode (both `newN` and `newL:*`), peek at next word
    - Compare current word's lesson with next word's lesson using `lessonNamesEqual`
    - If different: show transition notification with continue (`llc:{mode}`) and stop (`lls:{mode}`) buttons
    - If same or first word in session: show next question directly
    - Handle null→non-null and non-null→null transitions with appropriate messages
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 4.5 Add `handleLessonTransition` for continue/stop callbacks
    - `llc:{mode}` — continue: send next question in current mode
    - `lls:{mode}` — stop: show session summary (same as exit confirm) with stats
    - _Requirements: 1.2, 1.3_

  - [x] 4.6 Add lesson name display in answer feedback
    - In `handleAnswer`: after the `📊 سطح` line, add `📖 درس: {trimmedName}` if non-null
    - In `handleDunno`: same addition after the level line
    - Use `trimLessonName` to get display value; skip line if null
    - Consistent across all modes (review, new, leech)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 4.7 Register new callback prefixes in `handleLeitnerCallback` dispatcher
    - Add cases for `CB_PREFIX.LEITNER_LESSON_PICK`, `CB_PREFIX.LEITNER_LESSON_CONT`, `CB_PREFIX.LEITNER_LESSON_STOP`
    - Route to `handleLessonPicker` and `handleLessonTransition`
    - Update `pickWordForMode` to handle lesson-filtered modes using `pickNextNewWordByLesson`
    - _Requirements: 4.1, 4.9_

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Property-based tests for lesson picker and transition logic
  - [x] 6.1 Write property test for lesson transition detection (Property 3)
    - **Property 3: Lesson transition detection correctness**
    - Test: notification shown IFF `lessonNamesEqual(current, next)` is false (non-first word)
    - Test: first word never triggers notification
    - Minimum 100 iterations
    - **Validates: Requirements 1.1, 1.4, 1.5, 1.6**

  - [x] 6.2 Write property test for lesson picker completeness (Property 4)
    - **Property 4: Lesson picker shows exactly the lessons with unlearned words**
    - Given arbitrary word sets and user-learned sets, verify picker list matches expected
    - Verify word counts are accurate
    - Minimum 100 iterations
    - **Validates: Requirements 4.3, 4.4**

  - [x] 6.3 Write property test for lesson deduplication (Property 5)
    - **Property 5: Lesson picker deduplicates trimmed lesson names**
    - Generate word lists with lesson names differing only by whitespace
    - Verify no duplicate trimmed names in picker output
    - Minimum 100 iterations
    - **Validates: Requirements 3.3**

  - [x] 6.4 Write property test for lesson-filtered word picker (Property 6)
    - **Property 6: Lesson-filtered learning only produces words from selected lesson**
    - Verify every word returned has matching trimmed lesson name
    - Minimum 100 iterations
    - **Validates: Requirements 4.8**

  - [x] 6.5 Write property test for pagination invariants (Property 7)
    - **Property 7: Pagination invariants**
    - For arbitrary list sizes and page size 20: verify correct page content, button visibility rules
    - Page 1 has no prev button; last page has no next button; middle pages have both
    - Minimum 100 iterations
    - **Validates: Requirements 4.5, 4.6, 4.7**

  - [x] 6.6 Write property test for lesson name display (Property 8)
    - **Property 8: Lesson name display in feedback shown IFF trimmed name is non-null**
    - For arbitrary lesson_name values, verify "📖 درس:" line presence matches `trimLessonName(name) !== null`
    - Minimum 100 iterations
    - **Validates: Requirements 2.1, 2.2**

- [x] 7. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- No database schema changes are needed — `lesson_name` already exists in the `words` table
- The project currently has no test framework; task 1.3 sets up `vitest` + `fast-check`
- All callback data formats stay within the 64-byte Telegram limit

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1", "2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "4.5", "4.6"] },
    { "id": 4, "tasks": ["4.7"] },
    { "id": 5, "tasks": ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6"] }
  ]
}
```

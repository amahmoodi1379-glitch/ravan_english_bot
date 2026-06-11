# Implementation Plan: Zero-Risk Refactor

## Overview

Refactor the Ravan English Bot codebase to improve readability, modularity, and maintainability without any changes to user-visible behavior, database schema, or external API contracts. Each task is independently committable with passing typecheck and tests.

## Tasks

- [x] 1. Extract Telegram types to dedicated module
  - [x] 1.1 Create `src/bot/types.ts` and move Telegram interfaces
    - Move `TelegramUser`, `TelegramChat`, `TelegramMessage`, `TelegramCallbackQuery`, `TelegramUpdate` from `src/bot/router.ts` to a new `src/bot/types.ts`
    - Update all import paths across the codebase that reference these types from `../bot/router` to `../bot/types`
    - Verify `tsc --noEmit` passes and `vitest run` passes
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 2. Decompose Leitner handler — extract utilities
  - [x] 2.1 Create `src/bot/handlers/leitner/utils.ts`
    - Move type definitions (`ReviewMode`, `LeitnerQuestionRow`) from `src/bot/handlers/leitner.ts`
    - Move mode-parsing functions (`parseMode`, `extractMode`, `isReviewMode`, `getLevelFromMode`, `isNewMode`, `isLessonMode`, `getLessonIdFromMode`, `isReviewModeType`)
    - Move button builders (`exitButton`, `nextButton`, `ignoreButton`, `unleechButton`, `homeButton`, `nextAndExitRows`, `exitButtonText`, `exitConfirmText`)
    - Move helper functions (`getQuestionStyleForStage`, `getStylesForType`, `getCorrectOptionText`, `removeInlineKeyboard`)
    - Move related constants (`TEST_TYPE_STAGE`, `TEST_TYPE_STYLE_ALIASES`)
    - Export all moved items as named exports
    - _Requirements: 5.3, 7.1, 7.2, 7.3_

- [x] 3. Decompose Leitner handler — extract question picker
  - [x] 3.1 Create `src/bot/handlers/leitner/question-picker.ts`
    - Move `pickQuestionForUserWord`, `pickRandomUnseenQuestion`, `pickRandomQuestionAny` from `src/bot/handlers/leitner.ts`
    - Move `pickWordForMode`, `sendLeitnerQuestion`, `sendCompletionMessage`
    - Import shared types and utilities from `./utils`
    - _Requirements: 5.1, 7.1, 7.2_

- [x] 4. Decompose Leitner handler — extract lesson picker
  - [x] 4.1 Create `src/bot/handlers/leitner/lesson-picker.ts`
    - Move `handleLessonPicker`, `checkLessonTransitionAndSend`, `handleLessonTransition` from `src/bot/handlers/leitner.ts`
    - Import shared types and utilities from `./utils`
    - Import `sendLeitnerQuestion` from `./question-picker`
    - _Requirements: 5.2, 7.1, 7.2_

- [x] 5. Decompose Leitner handler — create index module
  - [x] 5.1 Create `src/bot/handlers/leitner/index.ts` as the main dispatcher
    - Keep `startLeitnerForUser` and `handleLeitnerCallback` as the public API
    - Keep sub-handler orchestration functions (`handleHome`, `handleDunno`, `handleExitRequest`, `handleExitConfirm`, `handleAnswer`, `handleRating`, `handleIgnoreWord`, `handleIgnoreWordConfirm`, `handleUnleech`, `handleNewLevel`, `handleReviewLevel`)
    - Import from `./utils`, `./question-picker`, `./lesson-picker`
    - Remove the old `src/bot/handlers/leitner.ts` file
    - Update all imports across the codebase to reference the new path
    - Verify final file is under 400 lines
    - _Requirements: 5.4, 5.5, 7.2_

- [x] 6. Checkpoint — Leitner decomposition verification
  - Ensure `tsc --noEmit` passes and `vitest run` passes. Ask the user if questions arise.

- [x] 7. Extract license handler from bot router
  - [x] 7.1 Create `src/bot/handlers/license.ts`
    - Move `extractLicenseCode` and `applyLicenseCode` from `src/bot/router.ts`
    - Create `handleNewUserLicenseFlow` wrapping the new-user conditional block (no user found → create user → apply code)
    - Create `handleUnapprovedUserLicenseFlow` wrapping the unapproved-user conditional block
    - Export all functions as named exports
    - _Requirements: 3.1, 7.1, 7.2_

- [x] 8. Move stale session check to reading handler
  - [x] 8.1 Add `checkAndCancelStaleSession` to `src/bot/handlers/reading.ts`
    - Extract the `activeReadingSession` query + 2-hour age comparison + auto-cancel logic + active session message from `src/bot/router.ts`
    - The function returns `true` if a message was sent (caller returns early), `false` otherwise
    - _Requirements: 3.2, 7.1_

- [x] 9. Slim the bot router
  - [x] 9.1 Refactor `src/bot/router.ts` to use extracted handlers
    - Replace inlined license logic with calls to `handleNewUserLicenseFlow` and `handleUnapprovedUserLicenseFlow`
    - Replace inlined stale session logic with call to `checkAndCancelStaleSession`
    - Remove `import { queryOne, execute } from "../db/client"` — router must have no direct DB imports
    - Preserve exact order of condition checks: admin → no-text → no-user license → unapproved license → banned → touch user → /setname → quiz deep-link → /start → menu buttons → reading staleness → fallback
    - Verify router contains only dispatching logic and guard checks
    - _Requirements: 3.3, 3.4, 3.5_

- [x] 10. Checkpoint — Bot router decomposition verification
  - Ensure `tsc --noEmit` passes and `vitest run` passes. Ask the user if questions arise.

- [x] 11. Extract admin utilities
  - [x] 11.1 Create `src/admin/utils.ts`
    - Move `getCookie`, `isAdminAuthed`, `isLoginRateLimited`, `recordLoginAttempt`, `parseAndValidateQuestionForm`, `getQuestionRedirectPath` from `src/admin/router.ts`
    - Move the `loginAttempts` Map and rate limit constants
    - Move the `QuestionFormPayload` type
    - Export all as named exports
    - _Requirements: 4.4, 7.1, 7.2_

- [x] 12. Create admin route modules
  - [x] 12.1 Create `src/admin/routes/auth.ts`
    - Extract login page, login POST, and logout logic from `src/admin/router.ts`
    - Export `handleAuthRoutes(request, env, url): Promise<Response | null>`
    - _Requirements: 4.1, 4.5_

  - [x] 12.2 Create `src/admin/routes/words.ts`
    - Extract word CRUD and word questions routes
    - Export `handleWordRoutes(request, env, url): Promise<Response | null>`
    - _Requirements: 4.1, 4.5_

  - [x] 12.3 Create `src/admin/routes/texts.ts`
    - Extract text CRUD and text questions routes
    - Export `handleTextRoutes(request, env, url): Promise<Response | null>`
    - _Requirements: 4.1, 4.5_

  - [x] 12.4 Create `src/admin/routes/users.ts`
    - Extract user list/edit/save routes
    - Export `handleUserRoutes(request, env, url): Promise<Response | null>`
    - _Requirements: 4.1, 4.5_

  - [x] 12.5 Create `src/admin/routes/licenses.ts`
    - Extract license list/create routes
    - Export `handleLicenseRoutes(request, env, url): Promise<Response | null>`
    - _Requirements: 4.1, 4.5_

  - [x] 12.6 Refactor `src/admin/router.ts` to delegate to route modules
    - Keep CSRF validation and auth guard in the central router
    - Delegate to each domain handler based on URL pathname
    - Import shared utilities from `./utils`
    - _Requirements: 4.2, 4.3_

- [x] 13. Checkpoint — Admin decomposition verification
  - Ensure `tsc --noEmit` passes and `vitest run` passes. Each route module file is under 300 lines. Ask the user if questions arise.

- [x] 14. Improve Env types
  - [x] 14.1 Update `src/types.ts` with proper D1Database type
    - Change `DB: any` to `DB: D1Database` (import from `@cloudflare/workers-types`)
    - Type `ctx` parameter in `src/index.ts` fetch/scheduled handlers as `ExecutionContext`
    - _Requirements: 6.3_

- [x] 15. Replace `any` types across the codebase
  - [x] 15.1 Replace `any` in function signatures, return types, and variable declarations
    - Replace `params: any[]` in DB utility functions (`src/db/client.ts`) with `params: unknown[]`
    - Add explicit return type annotations to all exported functions lacking them
    - Replace `any` in admin route modules with explicit row interfaces for query results
    - Add `unknown` with inline comment where type cannot be narrowed (dynamic boundaries)
    - _Requirements: 6.1, 6.2, 6.4, 6.5_

- [x] 16. Checkpoint — Type safety verification
  - Ensure `tsc --noEmit` passes and `vitest run` passes. Ask the user if questions arise.

- [x] 17. Remove dead code
  - [x] 17.1 Remove unused exports, commented-out code blocks, and unused imports
    - Remove exported functions/types/constants not transitively referenced from entry point or test files
    - Remove contiguous commented-out code blocks (preserve JSDoc and explanatory comments)
    - Remove unused import statements and unused named bindings
    - Preserve all runtime-referenced and type-only-referenced symbols
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 18. Improve code readability
  - [x] 18.1 Add JSDoc comments to all exported functions
    - Add one-line purpose summary, `@param` tags for all parameters, `@returns` tag
    - _Requirements: 9.1_

  - [x] 18.2 Rename ambiguous local variables and extract magic constants
    - Rename single-letter and non-descriptive variables (`val`, `tmp`, `data`, `x`) to meaningful names (except `i`, `j`, `k` loop indices)
    - Extract numeric/string literals representing domain values to named constants in `src/config/constants.ts` (e.g., `STALE_SESSION_HOURS`, `ADMIN_SESSION_TTL_MS`, `QUESTION_PICK_MAX_ATTEMPTS`, `ADMIN_LIST_PAGE_SIZE`)
    - Leave literals as-is when the containing function/property name already describes the purpose
    - _Requirements: 9.2, 9.3, 9.4_

- [x] 19. Standardize file and export conventions
  - [x] 19.1 Enforce consistent file structure and named exports
    - Ensure each file has a single domain focus
    - Use named exports only (no default exports except `src/index.ts`)
    - Order file sections: imports → types → constants → helper functions → exported functions
    - Verify no circular dependencies exist (`tsc --noEmit`)
    - Move shared types used by multiple domains to `src/types.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 20. Final verification
  - [x] 20.1 Run full typecheck and test suite
    - Run `npx tsc --noEmit` — must exit with code 0
    - Run `npx vitest run` — must exit with code 0
    - Confirm no changes to SQL queries, string literals, keyboard layouts, or response structures
    - Confirm all time-based conditions preserved unchanged
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

## Notes

- Each task is independently committable — `tsc --noEmit` and `vitest run` must pass after each step
- No property-based tests are needed since this is a structural refactoring with no new algorithms
- The existing test suite + TypeScript compiler serve as the correctness oracle
- Checkpoints ensure incremental validation at major milestones
- All refactoring operations are mechanical move-or-extract — no string literals, SQL queries, or response structures change

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["7.1", "11.1"] },
    { "id": 6, "tasks": ["8.1", "12.1"] },
    { "id": 7, "tasks": ["9.1", "12.2", "12.3"] },
    { "id": 8, "tasks": ["12.4", "12.5"] },
    { "id": 9, "tasks": ["12.6"] },
    { "id": 10, "tasks": ["14.1"] },
    { "id": 11, "tasks": ["15.1"] },
    { "id": 12, "tasks": ["17.1"] },
    { "id": 13, "tasks": ["18.1", "18.2"] },
    { "id": 14, "tasks": ["19.1"] },
    { "id": 15, "tasks": ["20.1"] }
  ]
}
```

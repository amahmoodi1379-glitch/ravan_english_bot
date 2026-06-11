# Requirements Document

## Introduction

This specification defines a zero-risk refactoring of the Ravan English Bot codebase. The goal is to improve code readability, modularity, and maintainability without any changes to user-visible behavior, database schema, or external API contracts. The refactoring prepares the codebase for easier future development (vibe coding sessions) by removing dead code, extracting reusable modules, reducing file sizes, and improving type safety.

## Glossary

- **Bot_Router**: The main Telegram update dispatcher (`src/bot/router.ts`) that routes incoming messages and callbacks to handlers
- **Admin_Panel**: The HTTP-based admin interface (`src/admin/router.ts`) for managing words, texts, users, and quizzes
- **Handler**: A function or module in `src/bot/handlers/` responsible for processing a specific command or callback flow
- **DB_Module**: A file in `src/db/` that encapsulates database queries for a specific domain (e.g., leitner, reading, users)
- **Refactoring_Engine**: The overall refactoring process described by this specification
- **Dead_Code**: Code that is unreachable, unused exports, or commented-out blocks that serve no runtime purpose
- **Inline_Types**: TypeScript interfaces defined inline within implementation files rather than in dedicated type modules

## Requirements

### Requirement 1: Remove Dead Code

**User Story:** As a developer, I want all dead code removed from the codebase, so that I can read and navigate files without confusion from unused artifacts.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL remove all exported functions, types, and constants that are not transitively referenced from any entry point (the Wrangler-configured worker entry file and all test files) across the TypeScript source files
2. THE Refactoring_Engine SHALL remove all contiguous blocks of 1 or more commented-out lines that contain code statements (variable declarations, function calls, control flow, or imports), excluding JSDoc comments (/** ... */) and single-line explanatory comments that describe adjacent active code
3. THE Refactoring_Engine SHALL remove all unused import statements (including unused named bindings within an import statement) from every source file
4. THE Refactoring_Engine SHALL preserve all functions, types, and constants that are transitively referenced at runtime, via type-only imports, or in test files
5. WHEN all removals are complete, THE Refactoring_Engine SHALL verify that the TypeScript project compiles without errors (`tsc --noEmit` exits with code 0) and all existing tests pass (`vitest run` exits with code 0)

### Requirement 2: Extract Telegram Types to Dedicated Module

**User Story:** As a developer, I want Telegram-specific type definitions consolidated in a single location, so that I can find and update them without reading through handler logic.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL move the Telegram interfaces (TelegramUser, TelegramChat, TelegramMessage, TelegramCallbackQuery, TelegramUpdate) from `src/bot/router.ts` into a new file `src/bot/types.ts`, and `src/bot/router.ts` SHALL no longer contain those interface definitions after the move
2. THE Refactoring_Engine SHALL update all import paths referencing the moved types so that the TypeScript build (`tsc --noEmit` or equivalent) succeeds with zero type errors
3. THE Refactoring_Engine SHALL preserve the exact shape and field types of each moved interface such that a structural comparison between the original and moved definitions produces no differences in property names, property types, or optional/required modifiers
4. WHEN the refactoring is complete, THE Refactoring_Engine SHALL ensure all existing tests pass and no runtime behavior changes occur as verified by the test suite executing with zero failures

### Requirement 3: Decompose the Bot Router

**User Story:** As a developer, I want the bot router to be a thin dispatcher with no business logic inlined, so that I can understand routing at a glance.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL extract the license-code logic (the `extractLicenseCode` function, the `applyLicenseCode` function, and the two conditional blocks in `handleMessage` that handle new-user and unapproved-user license validation) from `src/bot/router.ts` into a dedicated handler module under `src/bot/handlers/`
2. THE Refactoring_Engine SHALL extract the reading-session staleness check logic (the `activeReadingSession` query and the 2-hour age comparison with auto-cancel) from `src/bot/router.ts` into the reading handler (`src/bot/handlers/reading.ts`)
3. WHEN the refactoring is complete, THE Bot_Router SHALL contain only dispatching logic — defined as: matching incoming text/commands/callback prefixes to handler function calls, and guard checks that determine user eligibility (user lookup, `is_approved` check, `is_banned` check) — and shall import no symbols from `src/db/client` (i.e., no direct `queryOne` or `execute` calls)
4. THE Refactoring_Engine SHALL preserve the exact order of condition checks and early returns in the message handler, specifically: admin check → no-text guard → no-user license flow → unapproved license flow → banned check → touch user → /setname → quiz deep-link → /start → menu buttons → reading staleness → fallback message
5. WHEN the refactored bot receives any Telegram update that was previously handled by the inlined logic, THE Bot_Router SHALL produce identical Telegram API responses (same message text, same reply markup) as before the refactoring

### Requirement 4: Decompose the Admin Panel Router

**User Story:** As a developer, I want the admin panel router split into smaller route modules, so that each file is focused and easy to modify independently.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL split the Admin_Panel into separate route modules by domain: `src/admin/routes/words.ts` (word CRUD + word questions), `src/admin/routes/texts.ts` (text CRUD + text questions), `src/admin/routes/users.ts` (user list/edit/save), `src/admin/routes/licenses.ts` (license list/create), and `src/admin/routes/auth.ts` (login/logout)
2. THE Refactoring_Engine SHALL keep a central admin router file (`src/admin/router.ts`) that performs CSRF validation, authentication checks, and delegates to each domain module based on the URL pathname
3. THE Refactoring_Engine SHALL preserve all existing HTTP endpoints, response codes, and HTML output exactly as they are — verified by confirming that every URL path and HTTP method combination produces the same response status and body structure
4. THE Refactoring_Engine SHALL keep shared helpers (`parseAndValidateQuestionForm`, `getCookie`, `isAdminAuthed`, `isLoginRateLimited`, `recordLoginAttempt`, `getQuestionRedirectPath`) in a shared admin utility module (`src/admin/utils.ts`)
5. WHEN the refactoring is complete, each route module file SHALL contain fewer than 300 lines of code

### Requirement 5: Decompose Large Handler Files

**User Story:** As a developer, I want handler files kept under a reasonable size, so that I can navigate and modify each concern independently.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL extract the question-picking functions (`pickQuestionForUserWord`, `pickRandomUnseenQuestion`, `pickRandomQuestionAny`) from `src/bot/handlers/leitner.ts` into a dedicated module at `src/bot/handlers/leitner/question-picker.ts`
2. THE Refactoring_Engine SHALL extract the lesson-picker UI logic (`handleLessonPicker` and `checkLessonTransitionAndSend`) from `src/bot/handlers/leitner.ts` into a dedicated module at `src/bot/handlers/leitner/lesson-picker.ts`
3. THE Refactoring_Engine SHALL extract the button-builder helpers (`exitButton`, `nextButton`, `ignoreButton`, `unleechButton`, `homeButton`, `nextAndExitRows`, `exitButtonText`, `exitConfirmText`) and mode-parsing utilities (`parseMode`, `extractMode`, `isReviewMode`, `getLevelFromMode`, `isNewMode`, `isLessonMode`, `getLessonIdFromMode`, `isReviewModeType`) from `src/bot/handlers/leitner.ts` into a shared utilities module at `src/bot/handlers/leitner/utils.ts`
4. WHEN the refactoring is complete, THE main leitner handler file (`src/bot/handlers/leitner.ts` or `src/bot/handlers/leitner/index.ts`) SHALL contain only the callback dispatcher (`handleLeitnerCallback`) and sub-handler functions that orchestrate the flow, and SHALL be under 400 lines
5. WHEN any user triggers a leitner-related callback, THE system SHALL produce identical Telegram API responses as before the decomposition, verified by all existing leitner tests passing without modification

### Requirement 6: Improve Type Safety

**User Story:** As a developer, I want stronger TypeScript typing throughout the codebase, so that the compiler catches errors before runtime.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL replace all `any` types in function signatures, return types, and variable declarations within `src/` (excluding test files) with specific types where the value's structure is used in the same file or defined in an imported interface
2. THE Refactoring_Engine SHALL add explicit return type annotations to all exported functions in `src/` that currently lack them
3. THE Refactoring_Engine SHALL type the `DB` property in the `Env` interface as `D1Database` from `@cloudflare/workers-types`, and type the `ctx` parameter in fetch/scheduled handlers as `ExecutionContext`
4. IF an `any` type cannot be replaced because the value crosses a dynamic boundary (e.g., `request.json()`, catch-block error variable, or third-party callback parameter without available type definitions), THEN THE Refactoring_Engine SHALL retain `any` or use `unknown` and add an inline comment stating the specific reason the type cannot be narrowed
5. THE Refactoring_Engine SHALL replace `params: any[]` in database utility functions with `params: unknown[]` to preserve call-site flexibility while disallowing unchecked member access on parameters

### Requirement 7: Standardize File and Export Conventions

**User Story:** As a developer, I want consistent patterns for file structure and exports, so that the codebase is predictable to navigate.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL ensure each file contains exports that belong to a single domain, where a domain is one of: a specific bot handler, a specific database access area, a utility category, configuration, or shared types
2. THE Refactoring_Engine SHALL use named exports across all modules, with no default exports except the Workers entry point file (`src/index.ts`)
3. THE Refactoring_Engine SHALL order sections within each file in the following sequence: imports → type/interface declarations → constants → helper (non-exported) functions → exported functions
4. THE Refactoring_Engine SHALL ensure no circular dependencies exist between modules, verifiable by running the TypeScript compiler (`tsc --noEmit`) without circular-reference errors
5. IF a type or interface is used by more than one domain module, THEN THE Refactoring_Engine SHALL place it in a shared types file (e.g., `src/types.ts`) rather than co-locating it with a single domain

### Requirement 8: Preserve All External Behavior

**User Story:** As a developer, I want the guarantee that the refactoring introduces zero user-facing changes, so that I can deploy it with confidence.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL preserve all Telegram bot responses, keyboard layouts, message texts, and callback behaviors exactly as they are — meaning no changes to string literals, emoji sequences, or inline keyboard structures passed to Telegram API calls
2. THE Refactoring_Engine SHALL preserve all HTTP endpoint paths, methods, response formats, and status codes of the Admin_Panel — verified by confirming that the complete set of URL path + method combinations produces unchanged response status codes and body content
3. THE Refactoring_Engine SHALL make zero changes to SQL query strings, query parameters, or their order in database calls
4. THE Refactoring_Engine SHALL preserve the scheduled event handler logic (all cleanup queries and license expiration logic) and the time-based conditions (2-hour reading session, 24-hour admin sessions, 7-day history cleanup, 90-day history cleanup, 60-day activity log, Iran hour === 1 check) without modification
5. THE Refactoring_Engine SHALL ensure the TypeScript compilation (`tsc --noEmit`) passes without errors after refactoring
6. THE Refactoring_Engine SHALL ensure all existing tests pass (`vitest run` exits with code 0) without modification to test assertions

### Requirement 9: Improve Code Readability

**User Story:** As a developer, I want inline comments and meaningful naming conventions applied consistently, so that the intent of each code block is immediately clear.

#### Acceptance Criteria

1. THE Refactoring_Engine SHALL add or update JSDoc comments on all exported functions so that each comment includes a one-line purpose summary, a `@param` tag for every parameter (with type and meaning), and a `@returns` tag describing the return value
2. THE Refactoring_Engine SHALL rename local variables that are single-letter (excluding conventional loop indices `i`, `j`, `k`) or whose name does not contain a word indicating domain meaning (e.g., `val`, `tmp`, `data`, `x`) to descriptive names reflecting their role in the enclosing function
3. THE Refactoring_Engine SHALL replace numeric literals (other than 0, 1, -1) and string literals longer than 1 character that represent domain values with named constants defined in the `src/config/constants.ts` module
4. IF a numeric or string literal is used only once and appears as a direct argument to a well-named function or property whose name already describes the literal's purpose, THEN THE Refactoring_Engine SHALL leave it as-is
5. WHEN the Refactoring_Engine completes all readability changes in a file, THE Refactoring_Engine SHALL produce output that passes the existing TypeScript compiler (`tsc --noEmit`) and existing tests without error, confirming no change in runtime behavior

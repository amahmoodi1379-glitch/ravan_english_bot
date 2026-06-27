-- 0030: User reports for Leitner word-test questions
--
-- Why: Let users flag a buggy/incorrect word-test question right after they
-- answer it. Admins review reported questions (paginated, most-reported first)
-- in the web panel, fix them, then reset the report counter.
--
-- Design:
-- • One row per (question, user). The UNIQUE(question_id, user_id) constraint
--   makes the "counter" = number of DISTINCT users who reported the question,
--   so a single user cannot inflate it (we INSERT OR IGNORE).
-- • "Reset counter to zero" (admin, after fixing) = DELETE the rows for that
--   question. A fresh report cycle can then begin (a user who reported before
--   can report again if the fix was insufficient).
-- • Scoped to word_questions only (Leitner). Reading questions are out of scope.

CREATE TABLE IF NOT EXISTS word_question_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(question_id, user_id),
  FOREIGN KEY (question_id) REFERENCES word_questions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_wqr_question ON word_question_reports(question_id);
CREATE INDEX IF NOT EXISTS idx_wqr_created ON word_question_reports(created_at);

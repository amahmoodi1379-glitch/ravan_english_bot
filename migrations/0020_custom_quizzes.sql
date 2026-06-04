-- سیستم آزمون سفارشی (Custom Quiz System)

CREATE TABLE IF NOT EXISTS custom_quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  total_time_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, active, completed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES admins(id)
);

CREATE TABLE IF NOT EXISTS custom_quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  question_index INTEGER NOT NULL,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL, -- '1','2','3','4'
  explanation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_quiz_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  link_token TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress, finished, auto_ended
  current_question_index INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (quiz_id) REFERENCES custom_quizzes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_quiz_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  chosen_option TEXT, -- NULL = unanswered, '1','2','3','4'
  answered_at TEXT,
  FOREIGN KEY (attempt_id) REFERENCES custom_quiz_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES custom_quiz_questions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cq_questions_quiz_index ON custom_quiz_questions(quiz_id, question_index);
CREATE INDEX IF NOT EXISTS idx_cq_questions_quiz ON custom_quiz_questions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_cq_links_token ON custom_quiz_links(link_token);
CREATE INDEX IF NOT EXISTS idx_cq_attempts_quiz_user ON custom_quiz_attempts(quiz_id, user_id);
CREATE INDEX IF NOT EXISTS idx_cq_attempts_user ON custom_quiz_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_cq_answers_attempt ON custom_quiz_answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_cq_answers_question ON custom_quiz_answers(question_id);

-- جدول دوئل‌ها (هر ردیف یک مَچ)
CREATE TABLE IF NOT EXISTS duel_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  difficulty TEXT NOT NULL,                    -- 'easy' یا 'hard'
  status TEXT NOT NULL DEFAULT 'waiting',      -- waiting / in_progress / completed
  player1_id INTEGER NOT NULL,
  player2_id INTEGER,
  winner_user_id INTEGER,
  is_draw INTEGER NOT NULL DEFAULT 0,
  player1_correct INTEGER NOT NULL DEFAULT 0,
  player2_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (player1_id) REFERENCES users(id),
  FOREIGN KEY (player2_id) REFERENCES users(id),
  FOREIGN KEY (winner_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_duel_matches_status
  ON duel_matches(status, difficulty, created_at);

-- سوال‌های هر دوئل (۵ سوال برای هر مچ)
CREATE TABLE IF NOT EXISTS duel_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duel_id INTEGER NOT NULL,
  question_index INTEGER NOT NULL,             -- از 1 تا 5
  word_id INTEGER NOT NULL,
  word_question_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (duel_id) REFERENCES duel_matches(id),
  FOREIGN KEY (word_id) REFERENCES words(id),
  FOREIGN KEY (word_question_id) REFERENCES word_questions(id)
);

CREATE INDEX IF NOT EXISTS idx_duel_questions_duel
  ON duel_questions(duel_id, question_index);

-- جواب‌های بازیکن‌ها در دوئل
CREATE TABLE IF NOT EXISTS duel_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duel_id INTEGER NOT NULL,
  duel_question_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  chosen_option TEXT NOT NULL,          -- 'A' / 'B' / 'C' / 'D'
  is_correct INTEGER,
  answered_at TEXT NOT NULL,
  FOREIGN KEY (duel_id) REFERENCES duel_matches(id),
  FOREIGN KEY (duel_question_id) REFERENCES duel_questions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_duel_answers_main
  ON duel_answers(duel_id, user_id, duel_question_id);

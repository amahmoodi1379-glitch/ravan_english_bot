-- جدول لاگ تولید سوالات با AI
CREATE TABLE IF NOT EXISTS ai_generation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL,
  word_english TEXT NOT NULL,
  generated_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, success, error
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_gen_log_word ON ai_generation_log(word_id);
CREATE INDEX IF NOT EXISTS idx_ai_gen_log_status ON ai_generation_log(status);
CREATE INDEX IF NOT EXISTS idx_ai_gen_log_created ON ai_generation_log(created_at);

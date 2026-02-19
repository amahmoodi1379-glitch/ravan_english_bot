-- افزودن نوع سوال به text_questions برای اولویت‌بندی یکنواخت
ALTER TABLE text_questions ADD COLUMN question_type TEXT NOT NULL DEFAULT 'reading';

-- مقداردهی داده‌های قبلی (برای سازگاری)
UPDATE text_questions
SET question_type = 'reading'
WHERE question_type IS NULL OR TRIM(question_type) = '';

CREATE INDEX IF NOT EXISTS idx_text_questions_text_type ON text_questions(text_id, question_type);

-- بهینه‌سازی سرعت درک مطلب (Reading)
-- این ایندکس باعث می‌شود پیدا کردن سوالات تکراری در یک سشن بسیار سریع‌تر انجام شود.

CREATE INDEX IF NOT EXISTS idx_utqh_session_question 
ON user_text_question_history(reading_session_id, question_id);

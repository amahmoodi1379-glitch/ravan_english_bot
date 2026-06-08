-- جلوگیری از ثبت سوال تکراری برای یک شماره سوال در یک دوئل
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_duel_questions 
ON duel_questions(duel_id, question_index);

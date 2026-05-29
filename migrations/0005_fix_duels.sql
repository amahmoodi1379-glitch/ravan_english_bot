CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_duel_answer 
ON duel_answers(duel_id, duel_question_id, user_id);

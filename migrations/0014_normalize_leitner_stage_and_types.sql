-- نرمال‌سازی stage های قدیمی/نامعتبر
UPDATE user_words_sm2
SET question_stage = CASE
  WHEN question_stage IS NULL OR question_stage < 1 THEN 1
  WHEN question_stage > 5 THEN 5
  ELSE question_stage
END;

-- نرمال‌سازی style های قدیمی به نوع‌های جدید
UPDATE word_questions SET question_style = 'en_to_fa' WHERE question_style = 'fa_meaning';
UPDATE word_questions SET question_style = 'fa_to_en' WHERE question_style = 'en_meaning';
UPDATE word_questions SET question_style = 'definition_to_word' WHERE question_style = 'word_from_definition';
UPDATE word_questions SET question_style = 'word_to_definition' WHERE question_style = 'en_definition';
UPDATE word_questions SET question_style = 'cloze' WHERE question_style = 'fill_blank';

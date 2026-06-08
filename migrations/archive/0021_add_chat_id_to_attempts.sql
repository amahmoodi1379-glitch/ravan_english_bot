-- اضافه کردن chat_id به جدول custom_quiz_attempts
-- برای push کردن نتایج به همه شرکت‌کنندگانی که آزمون را تمام کرده‌اند

ALTER TABLE custom_quiz_attempts ADD COLUMN chat_id INTEGER;

-- بهینه‌سازی کوئری‌های لایتنر (بسیار حیاتی)
-- قبلاً فقط روی (user_id, next_review_date) ایندکس بود.
-- اما کوئری شما شرط ignored و is_active هم دارد. این ایندکس جدید ترکیبی، سرعت را چند برابر می‌کند.
CREATE INDEX IF NOT EXISTS idx_leitner_compound 
ON user_words_sm2(user_id, ignored, next_review_date);

-- بهینه‌سازی جستجوی ادمین
-- جستجو روی نام کاربری و نام نمایشی بدون ایندکس، باعث اسکن کل جدول می‌شود.
-- هرچند جستجوی "شامل ..." (LIKE %...%) کاملاً از ایندکس استفاده نمی‌کند، 
-- اما وجود این‌ها برای جستجوهای دقیق و مرتب‌سازی ضروری است.
CREATE INDEX IF NOT EXISTS idx_users_username 
ON users(username);

CREATE INDEX IF NOT EXISTS idx_users_display_name 
ON users(display_name);

-- ایندکس برای تاریخچه سوالات (جلوگیری از کندی در بررسی تکراری بودن سوال)
-- شما در کدهای دوئل و ریدینگ مدام چک می‌کنید "آیا کاربر این سوال را دیده؟"
-- این ایندکس سرعت آن بررسی‌ها را تضمین می‌کند.
CREATE INDEX IF NOT EXISTS idx_history_check 
ON user_word_question_history(user_id, question_id, context);

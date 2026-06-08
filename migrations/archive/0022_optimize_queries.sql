-- بهینه‌سازی جامع دیتابیس - کاهش فشار بر D1 Free Tier
-- این مایگریشن هیچ داده‌ای را حذف نمی‌کند.

-- =========================================================
-- ۱. ایندکس‌های ترکیبی برای بهبود لیدربورد هفتگی/ماهانه
-- کوئری لیدربورد از activity_log شروع می‌کند و با created_at فیلتر می‌شود
-- سپس user_id و xp_delta لازم است. این ایندکس covering index ایجاد می‌کند.
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_activity_user_created_xp
ON activity_log(created_at, user_id, xp_delta);

-- =========================================================
-- ۲. ایندکس برای streak فعال (لیدربورد و جستجو)
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_users_streak_live
ON users(is_approved, is_banned, last_streak_date, streak_count DESC);

CREATE INDEX IF NOT EXISTS idx_users_streak_record
ON users(is_approved, is_banned, max_streak_record DESC);

-- =========================================================
-- ۳. ایندکس برای user_word_question_history (بررسی تکراری بودن)
-- context + answered_at نیاز‌مند ایندکس هستند برای جلوگیری از دابل‌کلیک
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_uwqh_user_question_context_answered
ON user_word_question_history(user_id, question_id, context, answered_at);

-- =========================================================
-- ۴. ایندکس برای reading_sessions (پاکسازی در cron)
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_reading_sessions_status_started
ON reading_sessions(status, started_at);

-- =========================================================
-- ۵. ایندکس ترکیبی برای user_words_sm2 (pickNextWordForUser)
-- این ایندکس مهم‌ترین تاثیر را روی سرعت لایتنر دارد.
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_sm2_user_ignored_active_review
ON user_words_sm2(user_id, ignored, next_review_date);

-- =========================================================
-- ۶. ایندکس برای admin_sessions (حذف منقضی‌ها در cron)
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
ON admin_sessions(expires_at);

-- =========================================================
-- ۷. ایندکس برای activity_log (حذف قدیمی‌ها در cron)
-- =========================================================
-- idx_activity_created_at قبلاً در 0008 ساخته شده، اینجا فقط تایید
-- CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at);

-- =========================================================
-- ۸. حذف ایندکس‌های تکراری/قدیمی (بدون حذف داده)
-- ایندکس idx_activity_created_xp از 0008 با ایندکس جدید بالا پوشش داده می‌شود
-- اما برای امنیت حذف نمی‌کنیم (فقط ایندکس جدید اضافه شد)
-- =========================================================

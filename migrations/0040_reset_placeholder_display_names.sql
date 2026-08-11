-- 0040: reset display names that are actually the instruction, not a name.
--
-- The old profile-settings screen said: "برای تغییر نام، دستور زیر رو بفرست:
-- /setname اسم_جدید" — and a lot of users sent it verbatim, so their display
-- name literally became "اسم_جدید". This clears those back to NULL; the next
-- time such a user interacts with the bot, touchExistingUser() backfills the
-- name from their Telegram first/last name (display_name = COALESCE(...)),
-- so they get their real name back with no action on their part.
--
-- Data-only: no structural change, so migrations/schema.sql is unaffected.
-- Going forward validateDisplayName() (src/db/profile.ts) rejects these texts.
--
-- The normalisation below mirrors normalizeForPlaceholder() in the code: unify
-- the Arabic/Persian letter variants (ي→ی, ك→ک), turn the separators people copy
-- along (_ - < > « ») into spaces, collapse doubled spaces, trim and lowercase.

UPDATE users
SET display_name = NULL,
    updated_at = datetime('now')
WHERE display_name IS NOT NULL
  AND lower(
        trim(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(display_name, 'ي', 'ی'),
                        'ك', 'ک'),
                      '_', ' '),
                    '-', ' '),
                  '<', ' '),
                '>', ' '),
              '«', ' '),
            '»', ' '),
          '  ', ' ')
        )
      ) IN (
        'اسم جدید',
        'اسم جدیدم',
        'اسم جدیدت',
        'اسم جدید من',
        'نام جدید',
        'نام جدیدم',
        'نام جدیدت',
        'نام جدید من',
        'اسم نمایشی',
        'نام نمایشی',
        'setname',
        'newname',
        'new name'
      );

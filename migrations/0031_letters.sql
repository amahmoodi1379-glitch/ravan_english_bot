-- 0031: Letters (نامه‌ها) — standalone anonymous letters between subscribers.
--
-- Why: A side feature, fully independent of lessons/XP/stats. Subscribed users
-- write anonymous letters under a nickname; each new letter fans out to up to 5
-- eligible recipients, who can reply (unlimited back-and-forth) or block the
-- sender. Identity is never revealed — only the nickname snapshot is shown.
--
-- Design:
-- • A new letter fans out to up to 5 recipients and creates one independent 1:1
--   thread per recipient (letter_threads). Each actual message/reply is a row in
--   letter_messages, which ALSO serves as the delivery record (carries
--   recipient_user_id, is_read, replied_at) — no separate deliveries table.
-- • sender_nickname is a SNAPSHOT taken at send time, so changing one's nickname
--   never rewrites old letters/replies and conversations stay coherent.
-- • Priority for "fewest letters received" = COUNT of letter_messages rows with
--   is_reply=0 for that recipient. Because everything is deleted after 30 days,
--   this count is naturally a ~last-30-days window.
-- • Blocks are stored on the REAL account id (letter_blocks), so they survive a
--   nickname change and a re-block cannot be bypassed.
-- • Settings live in a separate letter_users table (not extra users columns) to
--   keep this feature isolated; a missing row means "not yet onboarded".
-- • Retention: a cron deletes letter_messages older than 30 days plus orphaned
--   threads. The 7-day "unanswered drops out of inbox" rule is a read-time query
--   filter (not a delete) so a thread is never half-destroyed.

-- Per-user letters settings + onboarding marker. No row = not yet onboarded.
CREATE TABLE IF NOT EXISTS letter_users (
  user_id               INTEGER PRIMARY KEY,        -- FK users.id (app-enforced)
  nickname              TEXT NOT NULL,
  notif_enabled         INTEGER NOT NULL DEFAULT 1, -- 1 = send separate notif on new letter/reply
  receiving_disabled_at TEXT,                       -- NULL = receiving enabled; set = disabled (7-day lock from this ts)
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (sender, recipient) 1:1 conversation. A new-letter fan-out makes up to 5.
CREATE TABLE IF NOT EXISTS letter_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id       INTEGER NOT NULL,                 -- the original letter SENDER
  user_b_id       INTEGER NOT NULL,                 -- the RECIPIENT
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_letter_threads_a ON letter_threads(user_a_id);
CREATE INDEX IF NOT EXISTS idx_letter_threads_b ON letter_threads(user_b_id);

-- One row per actual message (original letter or reply). This row IS the delivery record.
CREATE TABLE IF NOT EXISTS letter_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id         INTEGER NOT NULL,
  sender_user_id    INTEGER NOT NULL,
  recipient_user_id INTEGER NOT NULL,
  sender_nickname   TEXT NOT NULL,                  -- SNAPSHOT at send time (never joined live)
  body              TEXT NOT NULL,
  is_reply          INTEGER NOT NULL DEFAULT 0,     -- 0 = original letter, 1 = reply
  ref_message_id    INTEGER,                        -- the message this replies to (for quote); NULL for originals
  is_read           INTEGER NOT NULL DEFAULT 0,
  replied_at        TEXT,                           -- set when the recipient has replied to THIS message
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_letter_msg_recipient ON letter_messages(recipient_user_id, is_reply, created_at);
CREATE INDEX IF NOT EXISTS idx_letter_msg_sender ON letter_messages(sender_user_id, is_reply, created_at);
CREATE INDEX IF NOT EXISTS idx_letter_msg_thread ON letter_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_letter_msg_created ON letter_messages(created_at);

-- Two-way block on REAL account ids (survives nickname changes).
CREATE TABLE IF NOT EXISTS letter_blocks (
  blocker_user_id INTEGER NOT NULL,
  blocked_user_id INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_letter_blocks_blocked ON letter_blocks(blocked_user_id);

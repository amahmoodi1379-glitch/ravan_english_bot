-- 0036: Cache channel-membership verification.
-- Previously the bot ran a Telegram getChatMember call for every required
-- channel on EVERY button press (before it could answer the callback), which
-- added a full Telegram round-trip of latency to each tap. This column records
-- when the user was last confirmed a member of all required channels; the gate
-- (ensureChannelMember in src/bot/router.ts) skips the Telegram call while the
-- timestamp is fresher than CHANNEL_VERIFY_TTL_MS (src/config/constants.ts).
ALTER TABLE users ADD COLUMN channel_verified_at TEXT;

import { Env } from "../../types";
import { sendMessage } from "../telegram-api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A single outbound message produced from a recipient. */
export interface BroadcastMessage {
  chatId: number;
  text: string;
  extra?: Record<string, unknown>;
}

/**
 * Send a message to many recipients, pacing sends to respect Telegram rate limits
 * (a 100ms pause every 25 messages) and swallowing per-recipient failures. This is
 * the shared version of the loop used by reminders/reports; per-call 429 backoff
 * is already handled inside telegram-api's fetchWithRetry.
 * @param env - The worker environment containing the bot token
 * @param recipients - The list of recipients to iterate
 * @param build - Maps a recipient to a message, or null to skip that recipient
 * @returns Count of messages sent and failed
 */
export async function broadcast<T>(
  env: Env,
  recipients: T[],
  build: (r: T) => BroadcastMessage | null
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const r of recipients) {
    const msg = build(r);
    if (!msg) continue;
    try {
      await sendMessage(env, msg.chatId, msg.text, msg.extra);
      sent++;
    } catch (err) {
      failed++;
      console.error("broadcast: send failed", err);
    }
    if (sent > 0 && sent % 25 === 0) {
      await sleep(100);
    }
  }

  return { sent, failed };
}

import { Env } from "../types";
import { applyPremiumEmojiToText, applyPremiumEmojiToMarkup } from "./premium-emojis";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Apply the central premium-emoji transform to an `extra`/options object:
 * animate registered emoji at the start of inline buttons. Returns a shallow
 * copy so callers' objects aren't mutated.
 */
function withPremiumMarkup(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!extra || !extra.reply_markup) return extra;
  return { ...extra, reply_markup: applyPremiumEmojiToMarkup(extra.reply_markup) };
}

/**
 * Send a text message to a Telegram chat.
 * @param env - The worker environment containing the bot token
 * @param chatId - The target chat ID to send the message to
 * @param text - The HTML-formatted message text
 * @param extra - Additional Telegram sendMessage parameters (e.g., reply_markup)
 * @returns The Telegram API response data, or null on failure
 */
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: applyPremiumEmojiToText(text),
    parse_mode: "HTML",
    ...withPremiumMarkup(extra)
  };

  return fetchWithRetry(url, body);
}

/**
 * Copy a message from one chat to another via Telegram API.
 * @param env - The worker environment containing the bot token
 * @param fromChatId - The source chat ID to copy from
 * @param messageId - The message ID to copy
 * @param toChatId - The destination chat ID to copy to
 * @param extra - Additional Telegram copyMessage parameters
 * @returns void
 */
export async function copyMessage(
  env: Env,
  fromChatId: number,
  messageId: number,
  toChatId: number,
  extra?: Record<string, unknown>
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/copyMessage`;
  const body: Record<string, unknown> = {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...withPremiumMarkup(extra)
  };
  await fetchWithRetry(url, body);
}

/**
 * Answer a Telegram callback query (dismiss the loading spinner on inline buttons).
 * @param env - The worker environment containing the bot token
 * @param callbackQueryId - The ID of the callback query to answer
 * @param text - Optional notification text to show the user
 * @param showAlert - Whether to show text as an alert popup (defaults to true)
 * @returns void
 */
export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string,
  showAlert: boolean = true
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId
  };

  if (text) {
    body.text = text;
    body.show_alert = showAlert;
  }

  await fetchWithRetry(url, body);
}

let cachedBotUsername: string | null = null;

/**
 * Retrieve the bot's username via the Telegram getMe endpoint (cached after first call).
 * @param env - The worker environment containing the bot token
 * @returns The bot's username string, or null if the request fails
 */
export async function getBotUsername(env: Env): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`;
    const resp = await fetch(url);
    const data = await resp.json() as { ok?: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
    return null;
  } catch (err) {
    console.error("Failed to get bot username:", err);
    return null;
  }
}

/**
 * Edit the text of an existing Telegram message.
 * @param env - The worker environment containing the bot token
 * @param chatId - The chat ID containing the message
 * @param messageId - The ID of the message to edit
 * @param text - The new HTML-formatted message text
 * @param extra - Additional Telegram editMessageText parameters
 * @returns The Telegram API response data, or null on failure
 */
export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<unknown> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: applyPremiumEmojiToText(text),
    parse_mode: "HTML",
    ...withPremiumMarkup(extra)
  };
  return await fetchWithRetry(url, body);
}

/**
 * Edit or remove the inline keyboard markup of an existing Telegram message.
 * @param env - The worker environment containing the bot token
 * @param chatId - The chat ID containing the message
 * @param messageId - The ID of the message whose markup to edit
 * @param replyMarkup - The new inline keyboard markup, or undefined to clear it
 * @returns void
 */
export async function editMessageReplyMarkup(
  env: Env,
  chatId: number,
  messageId: number,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
  };
  if (replyMarkup) {
    body.reply_markup = applyPremiumEmojiToMarkup(replyMarkup);
  } else {
    body.reply_markup = { inline_keyboard: [] };
  }
  await fetchWithRetry(url, body);
}

/**
 * Get a user's membership status in a chat/channel via the Telegram getChatMember endpoint.
 * @param env - The worker environment containing the bot token
 * @param chatId - The target chat/channel (numeric id or "@username")
 * @param userId - The Telegram user ID to check
 * @returns An object with the membership status and is_member flag, or null on failure
 */
export async function getChatMemberStatus(
  env: Env,
  chatId: number | string,
  userId: number
): Promise<{ status: string; isMember: boolean } | null> {
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { status?: string; is_member?: boolean };
    };
    if (!data.ok || !data.result?.status) {
      console.error("getChatMember failed:", JSON.stringify(data));
      return null;
    }
    return { status: data.result.status, isMember: data.result.is_member === true };
  } catch (err) {
    console.error("Network error in getChatMember:", err);
    return null;
  }
}

interface TelegramApiResponse {
  ok?: boolean;
  parameters?: { retry_after?: number };
  [key: string]: unknown;
}

async function fetchWithRetry(url: string, body: Record<string, unknown>, retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data = await resp.json().catch(() => ({})) as TelegramApiResponse;

      if (resp.ok) {
        return data;
      }

      if (resp.status === 429) {
        const retryAfter = data?.parameters?.retry_after || 1;
        console.warn(`Telegram Flood Wait: Sleeping for ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      console.error("Telegram API Error:", JSON.stringify(data));
      return data;
    } catch (err) {
      console.error("Network Error sending to Telegram:", err);
      await sleep(1000);
    }
  }
  return null;
}

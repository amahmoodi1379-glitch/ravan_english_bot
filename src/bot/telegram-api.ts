import { Env } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  };

  return fetchWithRetry(url, body);
}

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
    ...extra
  };
  await fetchWithRetry(url, body);
}

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

export async function editMessageText(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra
  };
  return await fetchWithRetry(url, body);
}

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
    body.reply_markup = replyMarkup;
  } else {
    body.reply_markup = { inline_keyboard: [] };
  }
  await fetchWithRetry(url, body);
}

async function fetchWithRetry(url: string, body: any, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const data: any = await resp.json().catch(() => ({}));

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

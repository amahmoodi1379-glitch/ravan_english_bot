import { Env } from "../types";

// یک وقفه کوچک (Sleep)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ارسال پیام ساده به تلگرام با قابلیت تلاش مجدد (Retry)
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  };

  await fetchWithRetry(url, body);
}

// پاسخ به callback_query
export async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId
  };

  if (text) {
    body.text = text;
    body.show_alert = true;
  }

  // اینجا معمولاً نیازی به retry سنگین نیست چون تعامل لحظه‌ای است
  // اما برای اطمینان از همان تابع استفاده می‌کنیم
  await fetchWithRetry(url, body);
}

// تابع کمکی برای هندل کردن محدودیت‌های تلگرام (429 Too Many Requests)
async function fetchWithRetry(url: string, body: any, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (resp.ok) {
        return; // موفقیت‌آمیز بود، خارج شو
      }

      const data: any = await resp.json();

      // خطای محدودیت سرعت (Flood Wait)
      if (resp.status === 429) {
        const retryAfter = data?.parameters?.retry_after || 1;
        console.warn(`Telegram Flood Wait: Sleeping for ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue; // دوباره تلاش کن
      }

      console.error("Telegram API Error:", JSON.stringify(data));
      return; // ارورهای دیگه (مثل 400 یا 403) رو بیخیال شو (شاید کاربر بلاک کرده باشه)

    } catch (err) {
      console.error("Network Error sending to Telegram:", err);
      // اگر خطای شبکه بود، یک ثانیه صبر کن و دوباره بزن
      await sleep(1000);
    }
  }
}

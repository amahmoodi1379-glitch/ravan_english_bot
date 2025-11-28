import { Env } from "../types";

/**
 * این تابع رشته initData تلگرام را می‌گیرد و بررسی می‌کند که آیا معتبر است یا خیر.
 * اگر معتبر بود، آیدی کاربر را برمی‌گرداند. اگر نه، null برمی‌گرداند.
 */
export async function validateInitData(telegramInitData: string, botToken: string): Promise<number | null> {
  const urlParams = new URLSearchParams(telegramInitData);
  const hash = urlParams.get("hash");

  // اگر هش وجود نداشت، یعنی داده نامعتبر است
  if (!hash) return null;

  // هش را از پارامترها حذف می‌کنیم تا بقیه را سورت کنیم
  urlParams.delete("hash");

  // پارامترها را الفبایی مرتب می‌کنیم
  const params: string[] = [];
  for (const [key, value] of urlParams.entries()) {
    params.push(`${key}=${value}`);
  }
  params.sort();
  
  // ساختن رشته data-check-string طبق مستندات تلگرام
  const dataCheckString = params.join("\n");

  const encoder = new TextEncoder();

  // 1. ساخت کلید اولیه با رشته ثابت "WebAppData"
  const secretKeyBase = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // 2. ساخت کلید مخفی با استفاده از توکن ربات
  const secretKeyBytes = await crypto.subtle.sign(
    "HMAC",
    secretKeyBase,
    encoder.encode(botToken)
  );

  const secretKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // 3. محاسبه امضا (Signature) برای داده‌های دریافتی
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(dataCheckString)
  );

  // تبدیل امضا به هگزادسیمال
  const calculatedHash = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 4. مقایسه هش محاسبه شده با هش تلگرام
  if (calculatedHash === hash) {
    // داده معتبر است! حالا آیدی کاربر را استخراج می‌کنیم
    const userStr = urlParams.get("user");
    if (userStr) {
      try {
        const userObj = JSON.parse(userStr);
        
        // چک کردن تاریخ انضا (مثلاً اگر داده برای بیش از ۲۴ ساعت پیش بود رد کنیم - اختیاری ولی حرفه‌ای)
        const authDate = Number(urlParams.get("auth_date") || 0);
        const now = Math.floor(Date.now() / 1000);
        if (now - authDate > 86400) {
           console.warn("InitData expired");
           return null;
        }

        return userObj.id;
      } catch (e) {
        return null;
      }
    }
  }

  return null;
}

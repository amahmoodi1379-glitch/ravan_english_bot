import { escapeHtml } from "../utils/response";
import { TRANSFER_ANNOUNCEMENT, transferMessage, ZABANYAR_URL } from "../bot/handlers/transfer";

/**
 * The «حالت انتقال» card at the top of the Zabanyar export page: its state,
 * the switch (with a confirmation), the moving-day steps, the announcement to
 * paste into 📢 اطلاع‌رسانی and a preview of the automatic reply.
 */
export function renderTransferCard(on: boolean): string {
  const state = on
    ? `<p style="font-weight:bold;color:#b45309">🚚 حالت انتقال <u>روشن</u> است: ربات به کاربرها فقط پیام انتقال (با کد خودشان) را می‌دهد، چیزی ثبت نمی‌کند و کارهای ساعتی (مسابقه، لیگ، گزارش‌ها، یادآورها) متوقف است. ادمین‌ها مثل قبل از ربات استفاده می‌کنند.</p>`
    : `<p style="font-weight:bold;color:#15803d">✅ حالت انتقال <u>خاموش</u> است: ربات کاملاً عادی کار می‌کند.</p>`;
  const confirmText = on
    ? "حالت انتقال خاموش شود و ربات دوباره عادی کار کند؟"
    : "حالت انتقال روشن شود؟ از این لحظه ربات برای کاربرها فقط پیام انتقال می‌فرستد و دیگر چیزی ثبت نمی‌کند.";
  return `
    <div style="border:2px solid ${on ? "#f59e0b" : "#d1d5db"};border-radius:12px;padding:14px;margin-bottom:22px">
      <h3 style="margin-top:0">🚚 حالت انتقال به زبان‌یار</h3>
      ${state}
      <form method="POST" action="/admin/export/transfer" onsubmit="return confirm(${escapeHtml(JSON.stringify(confirmText))})">
        <input type="hidden" name="mode" value="${on ? "off" : "on"}">
        <button type="submit">${on ? "↩️ خاموش کردن حالت انتقال (برگشت به حالت عادی)" : "🚚 روشن کردن حالت انتقال"}</button>
      </form>
      <details style="margin-top:12px">
        <summary>مراحل روز انتقال و متن‌های آماده</summary>
        <ol style="line-height:2">
          <li>زبان‌یار روی <b>${escapeHtml(ZABANYAR_URL.replace("https://", ""))}</b> آماده باشد.</li>
          <li>همین‌جا حالت انتقال را <b>روشن</b> کن.</li>
          <li>پایین همین صفحه «ساختن فایل خروجی» را بزن و فایل را در پنل زبان‌یار، «درون‌ریزی از ربات»، بارگذاری کن.</li>
          <li>در ربات، «📢 اطلاع‌رسانی» را بزن و متن زیر را برای همه بفرست.</li>
        </ol>
        <p>متن اطلاعیه (کپی کن):</p>
        <textarea readonly rows="10" style="width:100%;direction:rtl">${escapeHtml(TRANSFER_ANNOUNCEMENT)}</textarea>
        <p>جوابی که ربات در حالت انتقال به هر پیام کاربر می‌دهد (با کد لایسنس خود همان کاربر و دو دکمه‌ی «ورود به زبان‌یار» و «دانلود اپ اندروید»):</p>
        <pre style="white-space:pre-wrap;background:#f3f4f6;padding:10px;border-radius:8px">${escapeHtml(transferMessage("کد-لایسنس-همان-کاربر").replace(/<[^>]+>/g, ""))}</pre>
      </details>
    </div>`;
}

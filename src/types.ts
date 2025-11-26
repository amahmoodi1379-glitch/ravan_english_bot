// Env: متغیرهای محیطی Cloudflare Worker
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_PASSWORD?: string;
  GEMINI_API_KEY?: string;  // برای سوال‌سازی با جمینای
  DB: any; // D1 Database
}

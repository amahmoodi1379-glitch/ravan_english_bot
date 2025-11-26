// Env: متغیرهای محیطی Cloudflare Worker
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  DB: any; // دیتابیس D1 (الان برای راحتی any گذاشتیم)
}

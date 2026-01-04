// Env: متغیرهای محیطی Cloudflare Worker
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_PASSWORD?: string;

  OPENAI_API_KEY?: string;

  GEMINI_API_KEY?: string;

  DB: any; // D1 database binding
}

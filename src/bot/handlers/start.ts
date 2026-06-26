import { Env } from "../../types";
import { TelegramUpdate } from "../types";
import { sendMessage } from "../telegram-api";
import { getMainMenuKeyboard } from "../keyboards";
import { pe, PE } from "../premium-emojis";
import { escapeHtml } from "../../utils/html";

/**
 * Handle the /start command by greeting the user and showing the main menu.
 * @param env - The worker environment containing the bot token
 * @param update - The Telegram Update object containing the /start message
 * @returns void
 */
export async function handleStartCommand(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const firstName = message.from?.first_name ?? "";

  const greeting = firstName
    ? `سلام <b>${escapeHtml(firstName)}</b> ${pe(PE.WAVE, "👋")}`
    : `سلام ${pe(PE.WAVE, "👋")}`;

  const welcomeText =
    `${greeting}\n\n` +
    `${pe(PE.ROCKET, "🚀")} به ربات یادگیری زبان انگلیسی خوش اومدی!\n\n` +
    `${pe(PE.BRAIN, "🧠")} واژه یاد بگیر\n` +
    `${pe(PE.BOOKS, "📚")} درک مطلب تمرین کن\n` +
    `${pe(PE.TROPHY, "🏆")} با بقیه رقابت کن\n\n` +
    `از منوی زیر یکی از گزینه‌ها رو انتخاب کن 👇`;

  await sendMessage(env, chatId, welcomeText, {
    reply_markup: getMainMenuKeyboard()
  });
}

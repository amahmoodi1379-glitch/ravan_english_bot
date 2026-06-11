import { Env } from "../../types";
import { TelegramUpdate } from "../types";
import { sendMessage } from "../telegram-api";
import { getMainMenuKeyboard } from "../keyboards";

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

  const welcomeText = firstName
    ? `سلام ${firstName} 👋\n\nبه ربات یادگیری زبان انگلیسی خوش اومدی.\nاز منوی زیر یکی از گزینه‌ها رو انتخاب کن.`
    : `سلام 👋\n\nبه ربات یادگیری زبان انگلیسی خوش اومدی.\nاز منوی زیر یکی از گزینه‌ها رو انتخاب کن.`;

  await sendMessage(env, chatId, welcomeText, {
    reply_markup: getMainMenuKeyboard()
  });
}

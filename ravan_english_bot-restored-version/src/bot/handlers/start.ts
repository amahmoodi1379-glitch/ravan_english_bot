import { Env } from "../../types";
import { TelegramUpdate } from "../router";
import { sendMessage } from "../telegram-api";
import { getMainMenuKeyboard } from "../keyboards";

// هندل کردن /start
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

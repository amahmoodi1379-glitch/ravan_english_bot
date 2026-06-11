export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  video?: { file_id: string; file_size?: number; width?: number; height?: number; duration?: number };
  audio?: { file_id: string; file_size?: number; duration?: number };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; file_size?: number; duration?: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  [key: string]: unknown;
}

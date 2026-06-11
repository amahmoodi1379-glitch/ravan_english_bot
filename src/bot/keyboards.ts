export const MAIN_MENU_BUTTON_TRAINING = "🎯 تمرین‌ها";
export const MAIN_MENU_BUTTON_PROFILE = "👤 پروفایل و آمار";
export const MAIN_MENU_BUTTON_LEADERBOARD = "🏆 لیدربورد";

export const TRAINING_MENU_BUTTON_LEITNER = "🧠 لایتنر واژگان";
export const TRAINING_MENU_BUTTON_READING = "📖 تست درک مطلب";
export const TRAINING_MENU_BUTTON_BACK = "⬅️ بازگشت به منوی اصلی";

export const PROFILE_MENU_BUTTON_SETTINGS = "⚙️ تنظیمات پروفایل";
export const PROFILE_MENU_BUTTON_STATS = "📈 آمار فعالیت";
export const PROFILE_MENU_BUTTON_SUMMARY = "🪪 خلاصه پروفایل";

interface ReplyKeyboardMarkup {
  keyboard: { text: string; style?: string }[][];
  resize_keyboard: boolean;
  one_time_keyboard: boolean;
}

interface AdminReplyKeyboardMarkup {
  keyboard: string[][];
  resize_keyboard: boolean;
  one_time_keyboard: boolean;
}

/**
 * Build the main menu reply keyboard with training, leaderboard, and profile buttons.
 * @returns A Telegram ReplyKeyboardMarkup object for the main menu
 */
export function getMainMenuKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: MAIN_MENU_BUTTON_TRAINING, style: "success" }],
      [{ text: MAIN_MENU_BUTTON_LEADERBOARD, style: "primary" }],
      [{ text: MAIN_MENU_BUTTON_PROFILE, style: "success" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

/**
 * Build the training sub-menu reply keyboard with leitner, reading, and back buttons.
 * @returns A Telegram ReplyKeyboardMarkup object for the training menu
 */
export function getTrainingMenuKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: TRAINING_MENU_BUTTON_LEITNER, style: "success" }],
      [{ text: TRAINING_MENU_BUTTON_READING, style: "primary" }],
      [{ text: TRAINING_MENU_BUTTON_BACK }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

/**
 * Build the profile sub-menu reply keyboard with settings, stats, summary, and back buttons.
 * @returns A Telegram ReplyKeyboardMarkup object for the profile menu
 */
export function getProfileMenuKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: PROFILE_MENU_BUTTON_SETTINGS }],
      [{ text: PROFILE_MENU_BUTTON_STATS }],
      [{ text: PROFILE_MENU_BUTTON_SUMMARY }],
      [{ text: TRAINING_MENU_BUTTON_BACK }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

export const ADMIN_MENU_BUTTON_LICENSE = "🎫 ایجاد لایسنس";
export const ADMIN_MENU_BUTTON_ANNOUNCE = "📢 اطلاع‌رسانی";
export const ADMIN_MENU_BUTTON_USER_MGMT = "👥 مدیریت کاربران";
export const ADMIN_MENU_BUTTON_ADMIN_MGMT = "👤 مدیریت ادمین‌ها";
export const ADMIN_MENU_BUTTON_QUIZ = "📝 آزمون‌ها";
export const ADMIN_MENU_BUTTON_EXIT = "🔙 خروج از پنل ادمین";

export const ADMIN_SUBMENU_BUTTON_BACK = "⬅️ بازگشت";
export const ADMIN_SUBMENU_BUTTON_NEXT_LICENSE = "🔄 لایسنس بعدی";
export const ADMIN_SUBMENU_BUTTON_CONFIRM = "✅ تایید و ارسال";
export const ADMIN_SUBMENU_BUTTON_CANCEL = "❌ انصراف";
export const ADMIN_SUBMENU_BUTTON_BAN = "🚫 مسدود کردن";
export const ADMIN_SUBMENU_BUTTON_UNBAN = "✅ رفع مسدودیت";
export const ADMIN_SUBMENU_BUTTON_ADD_ADMIN = "➕ افزودن ادمین";
export const ADMIN_SUBMENU_BUTTON_REMOVE_ADMIN = "➖ حذف ادمین";

/**
 * Build the admin panel main menu reply keyboard.
 * @returns An AdminReplyKeyboardMarkup object for the admin panel
 */
export function getAdminMenuKeyboard(): AdminReplyKeyboardMarkup {
  return {
    keyboard: [
      [ADMIN_MENU_BUTTON_LICENSE],
      [ADMIN_MENU_BUTTON_ANNOUNCE],
      [ADMIN_MENU_BUTTON_QUIZ],
      [ADMIN_MENU_BUTTON_USER_MGMT],
      [ADMIN_MENU_BUTTON_ADMIN_MGMT],
      [ADMIN_MENU_BUTTON_EXIT]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

/**
 * Build a custom admin sub-menu reply keyboard from the given button rows.
 * @param buttons - A 2D array of button label strings defining the keyboard layout
 * @returns An AdminReplyKeyboardMarkup object for the sub-menu
 */
export function getAdminSubMenuKeyboard(buttons: string[][]): AdminReplyKeyboardMarkup {
  return {
    keyboard: buttons,
    resize_keyboard: true,
    one_time_keyboard: false
  };
}


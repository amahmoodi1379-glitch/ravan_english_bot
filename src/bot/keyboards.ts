import { registerUserMenuLabels } from "./premium-emojis";

export const MAIN_MENU_BUTTON_TRAINING = "🎮 تمرین‌ها";
export const MAIN_MENU_BUTTON_PROFILE = "👤 پروفایل و آمار";
export const MAIN_MENU_BUTTON_LEADERBOARD = "🏆 لیدربورد";
export const MAIN_MENU_BUTTON_LETTERS = "💌 نامه‌ها";
export const MAIN_MENU_BUTTON_TOURNAMENT = "🎯 مسابقه";
export const MAIN_MENU_BUTTON_LEAGUE = "🏅 لیگ";
export const MAIN_MENU_BUTTON_HELP = "📖 راهنمای جامع ربات";

export const TRAINING_MENU_BUTTON_LEITNER = "🧠 لایتنر واژگان";
export const TRAINING_MENU_BUTTON_READING = "📖 تست درک مطلب";
export const TRAINING_MENU_BUTTON_BACK = "🏠 بازگشت به منوی اصلی";

export const PROFILE_MENU_BUTTON_SETTINGS = "⚙️ تنظیمات پروفایل";
export const PROFILE_MENU_BUTTON_STATS = "📊 آمار فعالیت";
export const PROFILE_MENU_BUTTON_SUMMARY = "🪪 خلاصه پروفایل";
export const PROFILE_MENU_BUTTON_MEDALS = "🎖 مدال‌ها";

export const LETTERS_MENU_BUTTON_WRITE = "✍️ نوشتن نامه";
export const LETTERS_MENU_BUTTON_INBOX = "📬 نامه‌های رسیده";
export const LETTERS_MENU_BUTTON_SETTINGS = "⚙️ تنظیمات نامه‌ها";
export const LETTERS_MENU_BUTTON_BACK = "🔙 بازگشت";

// Animate (and canonicalise) only these user-facing reply-keyboard buttons.
// Admin keyboards are intentionally excluded so their exact-text matching is
// never affected by the premium-emoji transform.
registerUserMenuLabels([
  MAIN_MENU_BUTTON_TRAINING,
  MAIN_MENU_BUTTON_PROFILE,
  MAIN_MENU_BUTTON_LEADERBOARD,
  MAIN_MENU_BUTTON_LETTERS,
  MAIN_MENU_BUTTON_TOURNAMENT,
  MAIN_MENU_BUTTON_LEAGUE,
  MAIN_MENU_BUTTON_HELP,
  TRAINING_MENU_BUTTON_LEITNER,
  TRAINING_MENU_BUTTON_READING,
  TRAINING_MENU_BUTTON_BACK,
  PROFILE_MENU_BUTTON_SETTINGS,
  PROFILE_MENU_BUTTON_STATS,
  PROFILE_MENU_BUTTON_SUMMARY,
  PROFILE_MENU_BUTTON_MEDALS,
  LETTERS_MENU_BUTTON_WRITE,
  LETTERS_MENU_BUTTON_INBOX,
  LETTERS_MENU_BUTTON_SETTINGS,
  LETTERS_MENU_BUTTON_BACK,
]);

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
  // Three rows of two, styles alternating so no two adjacent buttons (horizontally
  // or vertically) share a colour: row1 success|primary, row2 primary|success, …
  // A final full-width row holds the comprehensive-guide button, coloured red
  // (danger) so it stands out from the feature buttons above it as a "help" entry.
  return {
    keyboard: [
      [{ text: MAIN_MENU_BUTTON_TRAINING, style: "success" }, { text: MAIN_MENU_BUTTON_LEADERBOARD, style: "primary" }],
      [{ text: MAIN_MENU_BUTTON_TOURNAMENT, style: "primary" }, { text: MAIN_MENU_BUTTON_LEAGUE, style: "success" }],
      [{ text: MAIN_MENU_BUTTON_PROFILE, style: "primary" }, { text: MAIN_MENU_BUTTON_LETTERS, style: "success" }],
      [{ text: MAIN_MENU_BUTTON_HELP, style: "danger" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

/**
 * Build the letters sub-menu reply keyboard (write / inbox / settings / back).
 * @returns A Telegram ReplyKeyboardMarkup object for the letters section
 */
export function getLettersMenuKeyboard(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: LETTERS_MENU_BUTTON_WRITE, style: "success" }, { text: LETTERS_MENU_BUTTON_INBOX, style: "primary" }],
      [{ text: LETTERS_MENU_BUTTON_SETTINGS }],
      [{ text: LETTERS_MENU_BUTTON_BACK }]
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
      [{ text: PROFILE_MENU_BUTTON_STATS }, { text: PROFILE_MENU_BUTTON_MEDALS }],
      [{ text: PROFILE_MENU_BUTTON_SUMMARY }, { text: PROFILE_MENU_BUTTON_SETTINGS }],
      [{ text: TRAINING_MENU_BUTTON_BACK }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

export const ADMIN_MENU_BUTTON_LICENSE = "🎫 ایجاد لایسنس";
export const ADMIN_MENU_BUTTON_LICENSE_DEFAULT = "⚙️ پیش‌فرض لایسنس (۷۰۰ روز)";
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
      [ADMIN_MENU_BUTTON_LICENSE_DEFAULT],
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


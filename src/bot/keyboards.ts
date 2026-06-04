// دکمه‌های منوی اصلی
export const MAIN_MENU_BUTTON_TRAINING = "🎯 تمرین‌ها";
export const MAIN_MENU_BUTTON_PROFILE = "👤 پروفایل و آمار";
export const MAIN_MENU_BUTTON_LEADERBOARD = "🏆 لیدربورد";

// دکمه‌های منوی تمرین‌ها
export const TRAINING_MENU_BUTTON_LEITNER = "🧠 لایتنر واژگان";
export const TRAINING_MENU_BUTTON_READING = "📖 تست درک مطلب";
export const TRAINING_MENU_BUTTON_BACK = "⬅️ بازگشت به منوی اصلی";

// دکمه‌های منوی پروفایل
export const PROFILE_MENU_BUTTON_SETTINGS = "⚙️ تنظیمات پروفایل";
export const PROFILE_MENU_BUTTON_STATS = "📈 آمار فعالیت";
export const PROFILE_MENU_BUTTON_SUMMARY = "🪪 خلاصه پروفایل";

// Reply Keyboard اصلی (منوی اصلی)
export function getMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: MAIN_MENU_BUTTON_TRAINING }],
      [{ text: MAIN_MENU_BUTTON_LEADERBOARD }],
      [{ text: MAIN_MENU_BUTTON_PROFILE }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

// Reply Keyboard برای منوی تمرین‌ها
export function getTrainingMenuKeyboard() {
  return {
    keyboard: [
      [{ text: TRAINING_MENU_BUTTON_LEITNER }],
      [{ text: TRAINING_MENU_BUTTON_READING }],
      [{ text: TRAINING_MENU_BUTTON_BACK }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

// Reply Keyboard برای منوی پروفایل
export function getProfileMenuKeyboard() {
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

// === تابع اصلاح شده: کیبورد هوشمند صفحه‌بندی ===
// === دکمه‌های پنل ادمین (Reply Keyboard) ===
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

export function getAdminMenuKeyboard() {
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

export function getAdminSubMenuKeyboard(buttons: string[][]) {
  return {
    keyboard: buttons,
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

export function getPaginatedReadingKeyboard(
  titles: string[], 
  currentPage: number, 
  totalPages: number
) {
  const keyboard: any[][] = [];
  
  // ۱. چیدن عنوان‌ها (۲ تا در هر سطر برای اینکه خیلی دراز نشود)
  for (let i = 0; i < titles.length; i += 2) {
    const chunk = titles.slice(i, i + 2);
    keyboard.push(chunk.map(title => ({ text: title })));
  }

  // ۲. مدیریت دکمه‌های ناوبری (فقط اگر بیشتر از ۱ صفحه داریم)
  if (totalPages > 1) {
    const navRow: any[] = [];
    
    // اگر صفحه اول نیستیم -> دکمه "صفحه قبل" را نشان بده
    if (currentPage > 1) {
      navRow.push({ text: `▶️ صفحه ${currentPage - 1}` });
    }
    
    // اگر صفحه آخر نیستیم -> دکمه "صفحه بعد" را نشان بده
    if (currentPage < totalPages) {
      navRow.push({ text: `صفحه ${currentPage + 1} ◀️` });
    }
    
    // اگر دکمه‌ای ساخته شد، آن را به کیبورد اضافه کن
    if (navRow.length > 0) {
      keyboard.push(navRow);
    }
  }

  // ۳. دکمه بازگشت (همیشه پایین باشد)
  keyboard.push([{ text: TRAINING_MENU_BUTTON_BACK }]);

  return {
    keyboard: keyboard,
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

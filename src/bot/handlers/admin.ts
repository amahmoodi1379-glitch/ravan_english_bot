import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../router";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getMainMenuKeyboard } from "../keyboards";
import { 
  isAdmin, 
  getAdminByTelegramId, 
  addAdmin, 
  getAllAdmins,
  createLicense,
  getLicenseByCode,
  updateLicenseExpiration,
  findUser,
  banUser,
  unbanUser,
  deleteUser,
  createAnnouncement,
  getAnnouncement,
  getAllAnnouncements,
  updateAnnouncementStatus,
  updateAnnouncementCounts,
  logAnnouncementDelivery,
  getAnnouncementReport,
  getApprovedUsers
} from "../../db/admin";
import { scheduleAnnouncementSend } from "../../utils/batch-sender";

// Admin callback prefixes
const ADMIN_CB = {
  MAIN_MENU: "admin_main",
  LICENSE: "admin_license",
  USER_MGMT: "admin_user",
  ANNOUNCEMENT: "admin_announce",
  ADD_ADMIN: "admin_add_admin",
  REMOVE_ADMIN: "admin_remove_admin",
  BAN_USER: "admin_ban_user",
  UNBAN_USER: "admin_unban_user",
  DELETE_USER: "admin_delete_user",
  CHANGE_EXPIRE: "admin_change_expire",
  ANNOUNCE_CONFIRM: "admin_announce_confirm",
  ANNOUNCE_SEND: "admin_announce_send",
  ANNOUNCE_REPORT: "admin_announce_report",
  BACK: "admin_back",
  EXIT: "admin_exit"
};

// Admin state management (in production, use proper state management)
const adminStates = new Map<number, any>();

export async function handleAdminCommand(env: Env, update: TelegramUpdate): Promise<boolean> {
  const message = update.message;
  if (!message || !message.from) return false;

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const text = message.text;

  // Check if user is admin
  if (!await isAdmin(env, telegramId)) {
    return false;
  }

  const admin = await getAdminByTelegramId(env, telegramId);
  if (!admin) return false;

  // Handle /admin command
  if (text === "/admin") {
    await showAdminMainMenu(env, chatId, admin);
    return true;
  }

  // If no text, return
  if (!text) {
    return false;
  }

  // Handle number input for license generation
  if (/^\d+$/.test(text)) {
    await handleLicenseGeneration(env, chatId, admin, parseInt(text));
    return true;
  }

  // Handle user/license identifier for user management
  if (text.length > 0 && !text.startsWith("/")) {
    await handleUserIdentifier(env, chatId, admin, text.trim());
    return true;
  }

  return false;
}

async function showAdminMainMenu(env: Env, chatId: number, admin: any): Promise<void> {
  // Remove reply keyboard first
  await sendMessage(env, chatId, "🛠️ در حال ورود به پنل مدیریت...", {
    reply_markup: { remove_keyboard: true }
  });

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🎫 تولید لایسنس", callback_data: `${ADMIN_CB.LICENSE}:0` }
      ],
      [
        { text: "👥 مدیریت کاربران", callback_data: `${ADMIN_CB.USER_MGMT}:0` }
      ],
      [
        { text: "📢 اطلاع‌رسانی", callback_data: `${ADMIN_CB.ANNOUNCEMENT}:0` }
      ],
      [
        { text: "👥 مدیریت ادمین‌ها", callback_data: `${ADMIN_CB.ADD_ADMIN}:0` }
      ],
      [
        { text: "🔙 بازگشت به منوی کاربر", callback_data: `${ADMIN_CB.EXIT}:0` }
      ]
    ]
  };

  const adminName = admin.first_name || 'ادمین عزیز';
  const message = `🛠️ **پنل مدیریت ادمین**

سلام ${adminName}!

لطفاً یکی از گزینه‌های زیر را انتخاب کنید:`;

  await sendMessage(env, chatId, message, {
    reply_markup: keyboard,
    parse_mode: "Markdown"
  });
}

async function handleLicenseGeneration(env: Env, chatId: number, admin: any, days: number): Promise<void> {
  if (days <= 0 || days > 3650) { // Max 10 years
    await sendMessage(env, chatId, "⚠️ تعداد روز باید بین ۱ تا ۳۶۵۰ باشد.");
    return;
  }

  const license = await createLicense(env, days, admin.id);
  if (license) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: "🔄 تولید لایسنس دیگر", callback_data: `${ADMIN_CB.LICENSE}:0` },
          { text: "🔙 بازگشت", callback_data: `${ADMIN_CB.BACK}:0` }
        ]
      ]
    };

    await sendMessage(env, chatId, 
      `✅ **لایسنس جدید تولید شد**

🎫 **کد لایسنس:** \`${license}\`
⏰ **اعتبار:** ${days} روز

این کد را به کاربر مورد نظر خود ارسال کنید.`, 
      { 
        reply_markup: keyboard,
        parse_mode: "Markdown" 
      }
    );
  } else {
    await sendMessage(env, chatId, "❌ خطا در تولید لایسنس. لطفاً دوباره تلاش کنید.");
  }
}

async function handleUserIdentifier(env: Env, chatId: number, admin: any, identifier: string): Promise<void> {
  const user = await findUser(env, identifier);
  const license = await getLicenseByCode(env, identifier);
  
  if (!user && !license) {
    await sendMessage(env, chatId, "❌ کاربر یا لایسنس مورد نظر یافت نشد.");
    return;
  }

  let message = "";
  let keyboard: any = { inline_keyboard: [] };

  if (license) {
    message = `🎫 **اطلاعات لایسنس**

💳 **کد:** \`${license.code}\`
⏰ **اعتبار:** ${license.expiration_days || 'نامحدود'} روز
📅 **ایجاد:** ${new Date(license.created_at).toLocaleDateString('fa-IR')}
👤 **استفاده شده توسط:** ${license.used_by_name || 'هنوز استفاده نشده'}`;

    if (!license.used_by_user_id) {
      keyboard.inline_keyboard.push([
        { text: "📅 تغییر اعتبار", callback_data: `${ADMIN_CB.CHANGE_EXPIRE}:${license.code}` }
      ]);
    }
  }

  if (user) {
    const status = user.is_banned ? "🚫 مسدود" : "✅ فعال";
    const banInfo = user.banned_until ? `\n🚫 **مسدود شده تا:** ${new Date(user.banned_until).toLocaleDateString('fa-IR')}` : "";
    
    if (message) message += "\n\n";
    message += `👤 **اطلاعات کاربر**

🆔 **آیدی:** ${user.telegram_id}
👤 **نام:** ${user.display_name || user.first_name || 'نامشخص'}
🔗 **یوزرنیم:** ${user.username ? '@' + user.username : 'ندارد'}
📊 **سطح:** ${user.xp_total || 0} XP
🔥 **استریک:** ${user.streak_count || 0} روز
📅 **عضویت:** ${new Date(user.created_at).toLocaleDateString('fa-IR')}
📈 **وضعیت:** ${status}${banInfo}`;

    keyboard.inline_keyboard.push([
      { text: "🚫 مسدود کردن", callback_data: `${ADMIN_CB.BAN_USER}:${user.id}` },
      { text: "✅ رفع مسدودیت", callback_data: `${ADMIN_CB.UNBAN_USER}:${user.id}` }
    ]);
    
    keyboard.inline_keyboard.push([
      { text: "🗑️ حذف کاربر", callback_data: `${ADMIN_CB.DELETE_USER}:${user.id}` }
    ]);
  }

  keyboard.inline_keyboard.push([
    { text: "🔙 بازگشت", callback_data: `${ADMIN_CB.BACK}:0` }
  ]);

  await sendMessage(env, chatId, message, { 
    reply_markup: keyboard,
    parse_mode: "Markdown" 
  });
}

export async function handleAdminCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat.id || 0;
  const telegramId = callbackQuery.from.id;

  if (!await isAdmin(env, telegramId)) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }

  const admin = await getAdminByTelegramId(env, telegramId);
  if (!admin) return;

  const [action, param] = data.split(":");
  adminStates.set(telegramId, { action, param });

  switch (action) {
    case ADMIN_CB.LICENSE:
      await handleLicenseCallback(env, chatId, admin);
      break;
      
    case ADMIN_CB.USER_MGMT:
      await handleUserMgmtCallback(env, chatId, admin);
      break;
      
    case ADMIN_CB.ANNOUNCEMENT:
      await handleAnnouncementCallback(env, chatId, admin);
      break;
      
    case ADMIN_CB.ADD_ADMIN:
      await handleAddAdminCallback(env, chatId, admin);
      break;
      
    case ADMIN_CB.REMOVE_ADMIN:
      await handleRemoveAdminCallback(env, chatId, admin);
      break;
      
    case ADMIN_CB.BAN_USER:
      await handleBanUserCallback(env, chatId, admin, parseInt(param));
      break;
      
    case ADMIN_CB.UNBAN_USER:
      await handleUnbanUserCallback(env, chatId, admin, parseInt(param));
      break;
      
    case ADMIN_CB.DELETE_USER:
      await handleDeleteUserCallback(env, chatId, admin, parseInt(param));
      break;
      
    case ADMIN_CB.CHANGE_EXPIRE:
      await handleChangeExpireCallback(env, chatId, admin, param);
      break;
      
    case ADMIN_CB.ANNOUNCE_CONFIRM:
      await handleAnnounceConfirmCallback(env, chatId, admin, parseInt(param));
      break;
      
    case ADMIN_CB.ANNOUNCE_SEND:
      await handleAnnounceSendCallback(env, chatId, admin, parseInt(param));
      break;
      
    case ADMIN_CB.ANNOUNCE_REPORT:
      await handleAnnounceReportCallback(env, chatId, admin, parseInt(param));
      break;
      
    case ADMIN_CB.BACK:
      await showAdminMainMenu(env, chatId, admin);
      break;

    case ADMIN_CB.EXIT:
      await sendMessage(env, chatId, "✅ از پنل ادمین خارج شدی. به منوی اصلی برگشتی 👇", {
        reply_markup: getMainMenuKeyboard()
      });
      adminStates.delete(telegramId);
      break;

    default:
      await answerCallbackQuery(env, callbackQuery.id);
      return;
  }
  
  // Answer the callback query for all handled cases
  await answerCallbackQuery(env, callbackQuery.id);
}

async function handleLicenseCallback(env: Env, chatId: number, admin: any): Promise<void> {
  await sendMessage(env, chatId,
    `🎫 **تولید لایسنس جدید**

لطفاً تعداد روز اعتبار لایسنس را به صورت عدد وارد کنید:
مثال: \`30\` برای لایسنس ۳۰ روزه
مثال: \`365\` برای لایسنس یک ساله

حداکثر: ۳۶۵۰ روز (۱۰ سال)`,
    { parse_mode: "Markdown" }
  );
}

async function handleUserMgmtCallback(env: Env, chatId: number, admin: any): Promise<void> {
  await sendMessage(env, chatId, 
    `👥 **مدیریت کاربران**

لطفاً یکی از موارد زیر را ارسال کنید:
• 🎫 **کد لایسنس** برای مدیریت لایسنس
• 🆔 **آیدی عددی کاربر** (مثال: 123456789)
• 🔗 **یوزرنیم کاربر** (مثلاً @username یا username)

پس از ارسال، منوی مدیریت برای شما نمایش داده می‌شود.`, 
    { parse_mode: "Markdown" }
  );
}

async function handleAnnouncementCallback(env: Env, chatId: number, admin: any): Promise<void> {
  const announcements = await getAllAnnouncements(env);
  
  let message = `📢 **سیستم اطلاع‌رسانی**

آخرین اطلاعیه‌ها:\n\n`;
  
  if (announcements.length === 0) {
    message += "هنوز اطلاعیه‌ای ثبت نشده است.";
  } else {
    announcements.slice(0, 5).forEach((ann, index) => {
      const status = ann.status === 'completed' ? '✅' : 
                    ann.status === 'sending' ? '📤' : 
                    ann.status === 'confirmed' ? '⏳' : '📝';
      message += `${index + 1}. ${status} ${ann.title || 'بدون عنوان'} (${ann.sent_count}/${ann.total_users})\n`;
    });
  }
  
  message += `\nبرای ایجاد اطلاعیه جدید، متن خود را ارسال کنید.`;
  
  // Store state for new announcement
  adminStates.set(admin.telegram_id, { action: 'new_announcement' });
  
  await sendMessage(env, chatId, message, { parse_mode: "Markdown" });
}

async function handleAddAdminCallback(env: Env, chatId: number, admin: any): Promise<void> {
  const allAdmins = await getAllAdmins(env);
  
  let message = `👥 **مدیریت ادمین‌ها**

ادمین‌های فعلی:\n\n`;
  
  allAdmins.forEach((adm, index) => {
    const superAdmin = adm.is_super_admin ? '👑' : '👤';
    message += `${index + 1}. ${superAdmin} ${adm.first_name || 'نامشخص'} (${adm.telegram_id})\n`;
  });
  
  message += `\nبرای افزودن ادمین جدید، آیدی عددی تلگرام را ارسال کنید:`;
  
  adminStates.set(admin.telegram_id, { action: 'add_admin' });
  
  await sendMessage(env, chatId, message, { parse_mode: "Markdown" });
}

async function handleRemoveAdminCallback(env: Env, chatId: number, admin: any): Promise<void> {
  // Similar to add admin but for removal
  await handleAddAdminCallback(env, chatId, admin); // Reuse the same handler
}

async function handleBanUserCallback(env: Env, chatId: number, admin: any, userId: number): Promise<void> {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🚫 ۷ روز", callback_data: `admin_ban_confirm:${userId}:7` },
        { text: "🚫 ۳۰ روز", callback_data: `admin_ban_confirm:${userId}:30` }
      ],
      [
        { text: "🚫 ۹۰ روز", callback_data: `admin_ban_confirm:${userId}:90` },
        { text: "🚫 دائمی", callback_data: `admin_ban_confirm:${userId}:0` }
      ],
      [
        { text: "❌ انصراف", callback_data: `${ADMIN_CB.BACK}:0` }
      ]
    ]
  };

  await sendMessage(env, chatId, 
    `⚠️ **مسدود کردن کاربر**

مدت زمان مسدودیت را انتخاب کنید:`, 
    { reply_markup: keyboard, parse_mode: "Markdown" }
  );
}

async function handleUnbanUserCallback(env: Env, chatId: number, admin: any, userId: number): Promise<void> {
  const success = await unbanUser(env, userId);
  
  if (success) {
    await sendMessage(env, chatId, "✅ کاربر با موفقیت از مسدودیت خارج شد.");
  } else {
    await sendMessage(env, chatId, "❌ خطا در رفع مسدودیت کاربر.");
  }
}

async function handleDeleteUserCallback(env: Env, chatId: number, admin: any, userId: number): Promise<void> {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "⚠️ بله، حذف کن", callback_data: `admin_delete_confirm:${userId}` },
        { text: "❌ انصراف", callback_data: `${ADMIN_CB.BACK}:0` }
      ]
    ]
  };

  await sendMessage(env, chatId, 
    `⚠️ **حذف کاربر**

**هشدار:** این عمل غیرقابل بازگشت است و تمام داده‌های کاربر حذف می‌شود.

آیا از حذف این کاربر اطمینان دارید؟`, 
    { reply_markup: keyboard, parse_mode: "Markdown" }
  );
}

async function handleChangeExpireCallback(env: Env, chatId: number, admin: any, licenseCode: string): Promise<void> {
  adminStates.set(admin.telegram_id, { action: 'change_expire', licenseCode });
  
  await sendMessage(env, chatId, 
    `📅 **تغییر اعتبار لایسنس**

کد لایسنس: \`${licenseCode}\`

لطفاً تعداد روز اعتبار جدید را وارد کنید:`, 
    { parse_mode: "Markdown" }
  );
}

async function handleAnnounceConfirmCallback(env: Env, chatId: number, admin: any, announcementId: number): Promise<void> {
  const announcement = await getAnnouncement(env, announcementId);
  if (!announcement) {
    await sendMessage(env, chatId, "❌ اطلاعیه یافت نشد.");
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: "📤 ارسال به همه", callback_data: `${ADMIN_CB.ANNOUNCE_SEND}:${announcementId}` },
        { text: "📊 گزارش ارسال", callback_data: `${ADMIN_CB.ANNOUNCE_REPORT}:${announcementId}` }
      ],
      [
        { text: "❌ انصراف", callback_data: `${ADMIN_CB.BACK}:0` }
      ]
    ]
  };

  const message = `📢 **پیش‌نمایش اطلاعیه**

عنوان: ${announcement.title || 'بدون عنوان'}

متن:
${announcement.message}

آیا مایلید این اطلاعیه را ارسال کنید؟`;

  await sendMessage(env, chatId, message, { 
    reply_markup: keyboard,
    parse_mode: "Markdown" 
  });
}

async function handleAnnounceSendCallback(env: Env, chatId: number, admin: any, announcementId: number): Promise<void> {
  const announcement = await getAnnouncement(env, announcementId);
  if (!announcement) {
    await sendMessage(env, chatId, "❌ اطلاعیه یافت نشد.");
    return;
  }

  const users = await getApprovedUsers(env);
  await updateAnnouncementCounts(env, announcementId, 0, users.length);
  
  await sendMessage(env, chatId, 
    `📤 **شروع ارسال اطلاعیه**

تعداد کاربران: ${users.length}
وضعیت: در حال ارسال به صورت دسته‌ای (۱۰۰ کاربر در هر ثانیه)

این فرآیند ممکن است چند دقیقه طول بکشد. شما می‌توانید از منوی گزارش وضعیت را بررسی کنید.

📊 تخمین زمان: حدود ${Math.ceil(users.length / 100)} ثانیه`);
  
  // Start batch sending in background
  scheduleAnnouncementSend(env, announcementId, announcement.message);
}

async function handleAnnounceReportCallback(env: Env, chatId: number, admin: any, announcementId: number): Promise<void> {
  const report = await getAnnouncementReport(env, announcementId);
  
  let message = `📊 **گزارش ارسال اطلاعیه**

✅ ارسال شده: ${report.summary.sent}
❌ ناموفق: ${report.summary.failed}
⏭️ رد شده: ${report.summary.skipped}
📤 کل: ${report.summary.total}`;

  if (report.failedLogs.length > 0) {
    message += "\n\n**خطاها:**\n";
    report.failedLogs.slice(0, 5).forEach((log: any) => {
      message += `• ${log.first_name} (@${log.username || 'ندارد'}): ${log.error_message}\n`;
    });
  }

  await sendMessage(env, chatId, message, { parse_mode: "Markdown" });
}

// Handle admin text messages (for announcements, adding admins, etc.)
export async function handleAdminTextMessage(env: Env, update: TelegramUpdate): Promise<boolean> {
  const message = update.message;
  if (!message || !message.from) return false;

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const text = message.text?.trim();

  if (!text) return false;

  const admin = await getAdminByTelegramId(env, telegramId);
  if (!admin) return false;

  const state = adminStates.get(telegramId);
  if (!state) return false;

  switch (state.action) {
    case 'new_announcement':
      await handleNewAnnouncement(env, chatId, admin, text);
      break;
      
    case 'add_admin':
      await handleAddAdmin(env, chatId, admin, text);
      break;
      
    case 'change_expire':
      await handleChangeExpire(env, chatId, admin, text, state.licenseCode);
      break;
  }

  return true;
}

async function handleNewAnnouncement(env: Env, chatId: number, admin: any, text: string): Promise<void> {
  const announcementId = await createAnnouncement(env, null, text, admin.id);
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ تایید و ارسال", callback_data: `${ADMIN_CB.ANNOUNCE_CONFIRM}:${announcementId}` },
        { text: "❌ انصراف", callback_data: `${ADMIN_CB.BACK}:0` }
      ]
    ]
  };

  await sendMessage(env, chatId, 
    `📝 **پیش‌نمایش اطلاعیه**

متن اطلاعیه:
${text}

آیا مایلید این اطلاعیه را تایید و ارسال کنید؟`, 
    { reply_markup: keyboard, parse_mode: "Markdown" }
  );
  
  adminStates.delete(admin.telegram_id);
}

async function handleAddAdmin(env: Env, chatId: number, admin: any, text: string): Promise<void> {
  if (!/^\d+$/.test(text)) {
    await sendMessage(env, chatId, "❌ لطفاً آیدی عددی تلگرام را وارد کنید.");
    return;
  }

  const newAdminId = parseInt(text);
  const success = await addAdmin(env, newAdminId, undefined, undefined, admin.id);
  
  if (success) {
    await sendMessage(env, chatId, `✅ ادمین جدید با آیدی ${newAdminId} با موفقیت اضافه شد.`);
  } else {
    await sendMessage(env, chatId, "❌ خطا در افزودن ادمین (احتمالاً قبلاً اضافه شده است).");
  }
  
  adminStates.delete(admin.telegram_id);
}

async function handleChangeExpire(env: Env, chatId: number, admin: any, text: string, licenseCode: string): Promise<void> {
  if (!/^\d+$/.test(text)) {
    await sendMessage(env, chatId, "❌ لطفاً تعداد روز را به صورت عدد وارد کنید.");
    return;
  }

  const days = parseInt(text);
  if (days <= 0 || days > 3650) {
    await sendMessage(env, chatId, "❌ تعداد روز باید بین ۱ تا ۳۶۵۰ باشد.");
    return;
  }

  const success = await updateLicenseExpiration(env, licenseCode, days);
  
  if (success) {
    await sendMessage(env, chatId, `✅ اعتبار لایسنس با موفقیت به ${days} روز تغییر یافت.`);
  } else {
    await sendMessage(env, chatId, "❌ خطا در تغییر اعتبار لایسنس (احتمالاً استفاده شده است).");
  }
  
  adminStates.delete(admin.telegram_id);
}

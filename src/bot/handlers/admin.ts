import { Env } from "../../types";
import { TelegramUpdate } from "../types";
import {
  sendMessage,
  copyMessage
} from "../telegram-api";
import {
  getMainMenuKeyboard,
  getAdminMenuKeyboard,
  getAdminSubMenuKeyboard,
  ADMIN_MENU_BUTTON_LICENSE,
  ADMIN_MENU_BUTTON_LICENSE_DEFAULT,
  ADMIN_MENU_BUTTON_ANNOUNCE,
  ADMIN_MENU_BUTTON_QUIZ,
  ADMIN_MENU_BUTTON_USER_MGMT,
  ADMIN_MENU_BUTTON_ADMIN_MGMT,
  ADMIN_MENU_BUTTON_EXIT,
  ADMIN_SUBMENU_BUTTON_BACK,
  ADMIN_SUBMENU_BUTTON_NEXT_LICENSE,
  ADMIN_SUBMENU_BUTTON_CONFIRM,
  ADMIN_SUBMENU_BUTTON_CANCEL,
  ADMIN_SUBMENU_BUTTON_BAN,
  ADMIN_SUBMENU_BUTTON_UNBAN,
  ADMIN_SUBMENU_BUTTON_ADD_ADMIN,
  ADMIN_SUBMENU_BUTTON_REMOVE_ADMIN
} from "../keyboards";
import {
  enterQuizAdminMenu,
  handleQuizAdminMessage
} from "./custom_quiz_admin";
import {
  isAdmin,
  getAdminByTelegramId,
  DbAdmin,
  addAdmin,
  removeAdmin,
  getAllAdmins,
  insertLicense,
  findUserWithLicense,
  banUser,
  unbanUser,
  getApprovedUsers
} from "../../db/admin";
import {
  getAdminState,
  setAdminState,
  clearAllAdminState
} from "../../db/admin_state";
import {
  DEFAULT_LICENSE_DAYS,
  isLicenseDefaultDaysEnabled,
  setLicenseDefaultDaysEnabled
} from "../../db/settings";
import { toEnglishDigits } from "../../utils/digits";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AdminState {
  action:
    | 'menu'
    | 'await_license_code'
    | 'await_license_days'
    | 'await_announcement_content'
    | 'await_announcement_confirm'
    | 'await_user_search'
    | 'user_actions'
    | 'await_admin_id';
  licenseCode?: string;
  targetUserId?: number;
  targetUserTelegramId?: number;
  announcement?: {
    messageId: number;
    chatId: number;
  };
  adminAction?: 'add' | 'remove';
}

/**
 * Handle admin-specific bot commands (admin panel, announcements, user management).
 * @param env - The worker environment containing the D1 database binding
 * @param update - The Telegram Update object containing the admin message
 * @returns True if the message was handled as an admin command, false otherwise
 */
export async function handleAdminCommand(env: Env, update: TelegramUpdate): Promise<boolean> {
  const message = update.message;
  if (!message || !message.from) return false;

  const chatId = message.chat.id;
  const telegramId = message.from.id;
  const text = message.text;

  if (!await isAdmin(env, telegramId)) return false;

  const admin = await getAdminByTelegramId(env, telegramId);
  if (!admin) return false;

  if (text === "/admin") {
    await enterAdminPanel(env, chatId, admin);
    return true;
  }

  const quizHandled = await handleQuizAdminMessage(env, update);
  if (quizHandled) return true;

  const state = await getAdminState<AdminState>(env, telegramId, 'admin');

  if (!state) return false;

  switch (state.action) {
    case 'menu':
      return await handleMenuSelection(env, chatId, telegramId, admin, text || "");

    case 'await_license_code':
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await showAdminMenu(env, chatId);
        return true;
      }
      if (text && text.trim().length > 0) {
        const code = text.trim();
        // When the default-days mode is on, skip the prompt and register the
        // license immediately with DEFAULT_LICENSE_DAYS.
        if (await isLicenseDefaultDaysEnabled(env)) {
          await createLicenseAndReport(env, chatId, telegramId, admin, code, DEFAULT_LICENSE_DAYS);
          return true;
        }
        await setAdminState(env, telegramId, 'admin', {
          action: 'await_license_days',
          licenseCode: code
        });
        await sendMessage(env, chatId,
          `🎫 کد لایسنس: <code>${code}</code>\n\n⏳ لطفاً تعداد روز اعتبار را وارد کنید:`,
          { parse_mode: "HTML" }
        );
        return true;
      }
      break;

    case 'await_license_days': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await showAdminMenu(env, chatId);
        return true;
      }
      // Accept both English and Persian/Arabic digits for the day count.
      const normalized = text ? toEnglishDigits(text.trim()) : "";
      if (!/^\d+$/.test(normalized)) {
        await sendMessage(env, chatId, "⚠️ لطفاً یک عدد معتبر وارد کنید (۱ تا ۳۶۵۰).");
        return true;
      }
      const days = parseInt(normalized, 10);
      if (days <= 0 || days > 3650) {
        await sendMessage(env, chatId, "⚠️ تعداد روز باید بین ۱ تا ۳۶۵۰ باشد.");
        return true;
      }
      const code = state.licenseCode || "";
      await createLicenseAndReport(env, chatId, telegramId, admin, code, days);
      return true;
    }

    case 'await_announcement_content': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await showAdminMenu(env, chatId);
        return true;
      }
      const msg = message;
      let ann: { messageId: number; chatId: number } | undefined;

      if (msg.text) {
        ann = { messageId: msg.message_id, chatId };
      } else if (msg.photo && msg.photo.length > 0) {
        ann = { messageId: msg.message_id, chatId };
      } else if (msg.video) {
        ann = { messageId: msg.message_id, chatId };
      } else if (msg.audio) {
        ann = { messageId: msg.message_id, chatId };
      } else if (msg.document) {
        ann = { messageId: msg.message_id, chatId };
      } else if (msg.voice) {
        ann = { messageId: msg.message_id, chatId };
      }

      if (ann) {
        let contentType = "متن";
        let caption = "";
        if (msg.photo && msg.photo.length > 0) {
          contentType = "🖼️ عکس";
          caption = msg.caption || "";
        } else if (msg.video) {
          contentType = "🎥 ویدیو";
          caption = msg.caption || "";
        } else if (msg.audio) {
          contentType = "🎵 موسیقی";
          caption = msg.caption || "";
        } else if (msg.document) {
          contentType = "📄 سند/فایل";
          caption = msg.caption || "";
        } else if (msg.voice) {
          contentType = "🎙️ پیام صوتی";
          caption = msg.caption || "";
        } else if (msg.text) {
          contentType = "📝 متن";
          caption = msg.text;
        }

        await setAdminState(env, telegramId, 'admin', {
          action: 'await_announcement_confirm',
          announcement: ann
        });

        let confirmMsg = `📢 <b>محتوای اطلاعیه دریافت شد</b>\n\n📌 نوع: ${contentType}`;
        if (caption) {
          confirmMsg += `\n✏️ متن: ${caption.substring(0, 200)}${caption.length > 200 ? '...' : ''}`;
        }
        confirmMsg += `\n\nآیا برای ارسال به همه کاربران تایید می‌کنید؟`;

        await sendMessage(env, chatId, confirmMsg, {
          parse_mode: "HTML",
          reply_markup: getAdminSubMenuKeyboard([
            [ADMIN_SUBMENU_BUTTON_CONFIRM],
            [ADMIN_SUBMENU_BUTTON_CANCEL]
          ])
        });
        return true;
      }

      await sendMessage(env, chatId, "⚠️ لطفاً متن یا رسانه (عکس/فیلم/صوت/فایل) ارسال کنید.");
      return true;
    }

    case 'await_announcement_confirm':
      if (text === ADMIN_SUBMENU_BUTTON_CONFIRM) {
        // Immediately transition state to prevent double-send
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await sendAnnouncement(env, chatId, telegramId, admin, state.announcement);
        return true;
      }
      if (text === ADMIN_SUBMENU_BUTTON_CANCEL) {
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await showAdminMenu(env, chatId);
        return true;
      }
      await sendMessage(env, chatId, "⚠️ لطفاً یکی از دکمه‌ها را انتخاب کنید.");
      return true;

    case 'await_user_search': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await showAdminMenu(env, chatId);
        return true;
      }
      if (!text || text.trim().length === 0) {
        await sendMessage(env, chatId, "⚠️ لطفاً کد لایسنس، آیدی عددی یا یوزرنیم را ارسال کنید.");
        return true;
      }
      const identifier = text.trim();
      const user = await findUserWithLicense(env, identifier);

      if (!user) {
        await sendMessage(env, chatId,
          "❌ کاربر یافت نشد.\n\nبرای جستجوی دوباره، آیدی عددی، یوزرنیم یا کد لایسنس را ارسال کنید."
        );
        return true;
      }

      const now = Date.now();
      let remainingText = "نامحدود";
      if (user.used_at && user.expiration_days) {
        const usedAt = new Date(user.used_at).getTime();
        const expireAt = usedAt + user.expiration_days * 24 * 60 * 60 * 1000;
        const remainingDays = Math.ceil((expireAt - now) / (24 * 60 * 60 * 1000));
        remainingText = remainingDays > 0 ? `${remainingDays} روز` : "منقضی شده";
      }

      let daysSinceJoin = "نامشخص";
      if (user.created_at) {
        const createdAt = new Date(user.created_at).getTime();
        daysSinceJoin = `${Math.ceil((now - createdAt) / (24 * 60 * 60 * 1000))} روز`;
      }

      const statusText = user.is_banned ? "🚫 مسدود" : "✅ فعال";

      const profileMsg =
        `👤 <b>پروفایل کاربر</b>\n\n` +
        `🆔 <b>آیدی:</b> <code>${user.telegram_id}</code>\n` +
        `👤 <b>نام:</b> ${user.display_name || user.first_name || 'نامشخص'}\n` +
        `🔗 <b>یوزرنیم:</b> ${user.username ? '@' + user.username : 'ندارد'}\n` +
        `🎫 <b>لایسنس:</b> <code>${user.code || 'بدون لایسنس'}</code>\n` +
        `⏰ <b>اعتبار باقی‌مانده:</b> ${remainingText}\n` +
        `📅 <b>عضویت:</b> ${daysSinceJoin} پیش\n` +
        `📈 <b>وضعیت:</b> ${statusText}`;

      const isBanned = !!user.is_banned;
      await setAdminState(env, telegramId, 'admin', {
        action: 'user_actions',
        targetUserId: user.id,
        targetUserTelegramId: user.telegram_id
      });

      await sendMessage(env, chatId, profileMsg, {
        parse_mode: "HTML",
        reply_markup: getAdminSubMenuKeyboard([
          [isBanned ? ADMIN_SUBMENU_BUTTON_UNBAN : ADMIN_SUBMENU_BUTTON_BAN],
          [ADMIN_SUBMENU_BUTTON_BACK]
        ])
      });
      return true;
    }

    case 'user_actions': {
      if (text === ADMIN_SUBMENU_BUTTON_BAN && state.targetUserId) {
        const ok = await banUser(env, state.targetUserId, undefined, admin.id, 0);
        await sendMessage(env, chatId,
          ok ? "✅ کاربر با موفقیت مسدود شد." : "❌ خطا در مسدود کردن کاربر."
        );
      } else if (text === ADMIN_SUBMENU_BUTTON_UNBAN && state.targetUserId) {
        const ok = await unbanUser(env, state.targetUserId);
        await sendMessage(env, chatId,
          ok ? "✅ مسدودیت کاربر رفع شد." : "❌ خطا در رفع مسدودیت."
        );
      } else if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        await setAdminState(env, telegramId, 'admin', { action: 'menu' });
        await showAdminMenu(env, chatId);
        return true;
      } else {
        await sendMessage(env, chatId, "⚠️ لطفاً یکی از دکمه‌ها را انتخاب کنید.");
        return true;
      }

      await setAdminState(env, telegramId, 'admin', { action: 'await_user_search' });
      await sendMessage(env, chatId,
        `👥 جستجوی کاربر بعدی:\nکد لایسنس، آیدی عددی یا یوزرنیم را ارسال کنید.`
      );
      return true;
    }

    case 'await_admin_id': {
      if (text === ADMIN_SUBMENU_BUTTON_BACK) {
        await showAdminMgmtMenu(env, chatId);
        return true;
      }
      if (!text || !/^\d+$/.test(text)) {
        await sendMessage(env, chatId, "⚠️ لطفاً آیدی عددی تلگرام را وارد کنید.");
        return true;
      }
      const targetId = parseInt(text);

      if (state.adminAction === 'add') {
        const ok = await addAdmin(env, targetId, admin.id);
        await sendMessage(env, chatId,
          ok
            ? `✅ ادمین با آیدی <code>${targetId}</code> اضافه شد.`
            : `❌ خطا در افزودن ادمین (احتمالاً قبلاً وجود دارد).`,
          { parse_mode: "HTML" }
        );
      } else if (state.adminAction === 'remove') {
        const ok = await removeAdmin(env, targetId);
        await sendMessage(env, chatId,
          ok
            ? `✅ ادمین با آیدی <code>${targetId}</code> حذف شد.`
            : `❌ خطا در حذف ادمین (احتمالاً وجود ندارد یا Super Admin است).`,
          { parse_mode: "HTML" }
        );
      }

      await setAdminState(env, telegramId, 'admin', { action: 'menu' });
      await showAdminMgmtMenu(env, chatId);
      return true;
    }
  }

  return false;
}

async function enterAdminPanel(env: Env, chatId: number, admin: DbAdmin): Promise<void> {
  await clearAllAdminState(env, admin.telegram_id);
  await setAdminState(env, admin.telegram_id, 'admin', { action: 'menu' });
  await sendMessage(env, chatId, "🛠️ در حال ورود به پنل مدیریت...", {
    reply_markup: { remove_keyboard: true }
  });
  await showAdminMenu(env, chatId);
}

/**
 * Register a license and report the outcome to the admin. On success the
 * "next license" prompt (with its button) is shown and state is reset to menu.
 * @param env - The worker environment containing the D1 database binding
 * @param chatId - The Telegram chat ID to send messages to
 * @param telegramId - The admin's Telegram ID (for state updates)
 * @param admin - The acting admin record
 * @param code - The license code to register
 * @param days - The license validity in days
 */
async function createLicenseAndReport(
  env: Env,
  chatId: number,
  telegramId: number,
  admin: DbAdmin,
  code: string,
  days: number
): Promise<void> {
  const success = await insertLicense(env, code, days, admin.id);
  if (success) {
    await sendMessage(env, chatId,
      `✅ لایسنس <code>${code}</code> با ${days} روز اعتبار ثبت شد.\n\nلایسنس بعدی؟`,
      {
        parse_mode: "HTML",
        reply_markup: getAdminSubMenuKeyboard([
          [ADMIN_SUBMENU_BUTTON_NEXT_LICENSE],
          [ADMIN_SUBMENU_BUTTON_BACK]
        ])
      }
    );
  } else {
    // Keep the admin in the code-entry step so they can immediately retry with
    // a different code (or go back), instead of being dropped to the menu.
    await sendMessage(env, chatId,
      `❌ خطا در ثبت لایسنس. احتمالاً کد <code>${code}</code> قبلاً ثبت شده.\n\n🎫 کد دیگری وارد کنید:`,
      {
        parse_mode: "HTML",
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      }
    );
    await setAdminState(env, telegramId, 'admin', { action: 'await_license_code' });
    return;
  }
  await setAdminState(env, telegramId, 'admin', { action: 'menu' });
}

async function showAdminMenu(env: Env, chatId: number): Promise<void> {
  await sendMessage(env, chatId,
    `🛠️ <b>پنل مدیریت ادمین</b>\n\nلطفاً یکی از گزینه‌ها را انتخاب کنید:`,
    { parse_mode: "HTML", reply_markup: getAdminMenuKeyboard() }
  );
}

async function handleMenuSelection(
  env: Env,
  chatId: number,
  telegramId: number,
  admin: DbAdmin,
  text: string
): Promise<boolean> {
  switch (text) {
    case ADMIN_MENU_BUTTON_LICENSE:
      await setAdminState(env, telegramId, 'admin', { action: 'await_license_code' });
      await sendMessage(env, chatId,
        `🎫 <b>ایجاد لایسنس</b>\n\nکد لایسنس را وارد کنید:`,
        { parse_mode: "HTML", reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }
      );
      return true;

    case ADMIN_MENU_BUTTON_ANNOUNCE:
      await setAdminState(env, telegramId, 'admin', { action: 'await_announcement_content' });
      await sendMessage(env, chatId,
        `📢 <b>اطلاع‌رسانی</b>\n\nمتن یا رسانه (عکس/فیلم/صوت/فایل) اطلاعیه را ارسال کنید.`,
        { parse_mode: "HTML", reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }
      );
      return true;

    case ADMIN_MENU_BUTTON_USER_MGMT:
      await setAdminState(env, telegramId, 'admin', { action: 'await_user_search' });
      await sendMessage(env, chatId,
        `👥 <b>مدیریت کاربران</b>\n\nکد لایسنس، آیدی عددی یا یوزرنیم کاربر را ارسال کنید:`,
        { parse_mode: "HTML", reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }
      );
      return true;

    case ADMIN_MENU_BUTTON_ADMIN_MGMT:
      await showAdminMgmtMenu(env, chatId);
      return true;

    case ADMIN_MENU_BUTTON_QUIZ:
      await enterQuizAdminMenu(env, chatId, telegramId);
      return true;

    case ADMIN_SUBMENU_BUTTON_NEXT_LICENSE:
      await setAdminState(env, telegramId, 'admin', { action: 'await_license_code' });
      await sendMessage(env, chatId, `🎫 کد لایسنس بعدی را وارد کنید:`,
        { reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]]) }
      );
      return true;

    case ADMIN_MENU_BUTTON_LICENSE_DEFAULT: {
      const enabled = await isLicenseDefaultDaysEnabled(env);
      const next = !enabled;
      await setLicenseDefaultDaysEnabled(env, next);
      const msg = next
        ? `✅ حالت پیش‌فرض لایسنس <b>روشن</b> شد.\n\nاز این پس هنگام ساخت لایسنس، مدت اعتبار به‌صورت خودکار ${DEFAULT_LICENSE_DAYS} روز در نظر گرفته می‌شود و دیگر پرسیده نمی‌شود.`
        : `☑️ حالت پیش‌فرض لایسنس <b>خاموش</b> شد.\n\nاز این پس هنگام ساخت لایسنس، مدت روز اعتبار از شما پرسیده می‌شود.`;
      await sendMessage(env, chatId, msg, {
        parse_mode: "HTML",
        reply_markup: getAdminMenuKeyboard()
      });
      return true;
    }

    case ADMIN_SUBMENU_BUTTON_ADD_ADMIN:
      await setAdminState(env, telegramId, 'admin', { action: 'await_admin_id', adminAction: 'add' });
      await sendMessage(env, chatId, `➕ آیدی عددی تلگرام ادمین جدید:`, {
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;

    case ADMIN_SUBMENU_BUTTON_REMOVE_ADMIN:
      await setAdminState(env, telegramId, 'admin', { action: 'await_admin_id', adminAction: 'remove' });
      await sendMessage(env, chatId, `➖ آیدی عددی ادمین برای حذف:`, {
        reply_markup: getAdminSubMenuKeyboard([[ADMIN_SUBMENU_BUTTON_BACK]])
      });
      return true;

    case ADMIN_SUBMENU_BUTTON_BACK:
      await setAdminState(env, telegramId, 'admin', { action: 'menu' });
      await showAdminMenu(env, chatId);
      return true;

    case ADMIN_MENU_BUTTON_EXIT:
      await clearAllAdminState(env, telegramId);
      await sendMessage(env, chatId, "✅ از پنل ادمین خارج شدی. به منوی اصلی برگشتی 👇", {
        reply_markup: getMainMenuKeyboard()
      });
      return true;

    default:
      await sendMessage(env, chatId, "⚠️ لطفاً یکی از گزینه‌های منو را انتخاب کنید.");
      return true;
  }
}

async function showAdminMgmtMenu(env: Env, chatId: number): Promise<void> {
  const allAdmins = await getAllAdmins(env);
  let msg = `👤 <b>مدیریت ادمین‌ها</b>\n\n`;
  allAdmins.forEach((a, i) => {
    const role = a.is_super_admin ? '👑 Super' : '👤';
    msg += `${i + 1}. ${role} ${a.first_name || 'نامشخص'} (<code>${a.telegram_id}</code>)\n`;
  });

  await sendMessage(env, chatId, msg, {
    parse_mode: "HTML",
    reply_markup: getAdminSubMenuKeyboard([
      [ADMIN_SUBMENU_BUTTON_ADD_ADMIN, ADMIN_SUBMENU_BUTTON_REMOVE_ADMIN],
      [ADMIN_SUBMENU_BUTTON_BACK]
    ])
  });
}

async function sendAnnouncement(
  env: Env,
  adminChatId: number,
  adminTelegramId: number,
  admin: DbAdmin,
  announcement?: { messageId: number; chatId: number }
): Promise<void> {
  if (!announcement) {
    await sendMessage(env, adminChatId, "❌ خطا در اطلاعیه.");
    return;
  }

  const users = await getApprovedUsers(env);
  const total = users.length;

  if (total === 0) {
    await setAdminState(env, adminTelegramId, 'admin', { action: 'menu' });
    await sendMessage(env, adminChatId, "⚠️ هیچ کاربر تاییدشده‌ای وجود ندارد.", {
      reply_markup: getAdminMenuKeyboard()
    });
    return;
  }

  await sendMessage(env, adminChatId,
    `📤 <b>شروع ارسال اطلاعیه</b>\n\nتعداد کاربران: ${total}\n\nارسال شروع شد...`,
    { parse_mode: "HTML", reply_markup: getAdminMenuKeyboard() }
  );

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    try {
      await copyMessage(env, announcement.chatId, announcement.messageId, user.telegram_id);
      sent++;
    } catch (err: unknown) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errors.length < 5) errors.push(`${user.telegram_id}: ${errMsg}`);
    }

    // Minimal delay to avoid Telegram rate limits (free plan has 30s CPU timeout)
    if (i < users.length - 1 && (i + 1) % 25 === 0) {
      await sleep(100);
    }
  }

  let finalMsg =
    `📊 <b>گزارش نهایی ارسال</b>\n\n` +
    `✅ ارسال شده: ${sent}\n` +
    `❌ ناموفق: ${failed}\n` +
    `📤 کل: ${total}`;

  if (errors.length > 0) {
    finalMsg += `\n\n<b>نمونه خطاها:</b>\n${errors.join('\n')}`;
  }

  await setAdminState(env, adminTelegramId, 'admin', { action: 'menu' });
  await sendMessage(env, adminChatId, finalMsg, {
    parse_mode: "HTML",
    reply_markup: getAdminMenuKeyboard()
  });
}

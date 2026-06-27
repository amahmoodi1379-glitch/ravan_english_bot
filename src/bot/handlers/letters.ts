import { Env } from "../../types";
import { TelegramUpdate, TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { sendMessage, answerCallbackQuery } from "../telegram-api";
import { getLettersMenuKeyboard, getMainMenuKeyboard } from "../keyboards";
import { canonicalizeUserMenu } from "../premium-emojis";
import { escapeHtml } from "../../utils/html";
import { CB_PREFIX, LETTERS } from "../../config/constants";
import { DbUser, getUserByTelegramId } from "../../db/users";
import { getAdminState, setAdminState, deleteAdminState } from "../../db/admin_state";
import {
  getLetterUser,
  createLetterUser,
  updateNickname,
  setNotifEnabled,
  disableReceiving,
  enableReceiving,
  isReceivingDisabled,
  disableLockRemainingMs,
  isInboxVisible,
  validateNickname,
  validateLetterBody,
  validateReplyBody,
  countNewLettersToday,
  sendNewLetter,
  sendReply,
  getInbox,
  countUnread,
  getMessageForRecipient,
  getMessageById,
  markRead,
  isBlockedEitherWay,
  addBlock,
  LetterDelivery,
} from "../../db/letters";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LettersState {
  action: "await_nickname" | "await_edit_nickname" | "await_letter_body" | "await_reply_body";
  refMessageId?: number;
}

/** Convert ASCII digits to Persian for display. */
function faNum(n: number | string): string {
  return String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

/** A short, escaped one-line preview of a message body. */
function snippet(body: string, max = LETTERS.QUOTE_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? flat.slice(0, max).trim() + "…" : flat;
  return escapeHtml(cut);
}

/** Human "X روز / X ساعت" remaining string for the 7-day disable lock. */
function remainingText(ms: number): string {
  const totalHours = Math.ceil(ms / (60 * 60 * 1000));
  if (totalHours >= 24) {
    const days = Math.ceil(totalHours / 24);
    return `حدود ${faNum(days)} روز`;
  }
  return `حدود ${faNum(Math.max(1, totalHours))} ساعت`;
}

// ───────────────────────────────── entry / menus ─────────────────────────────

/** Entry point from the main-menu "نامه‌ها" button. */
export async function showLettersEntry(env: Env, user: DbUser, chatId: number): Promise<void> {
  const lu = await getLetterUser(env, user.id);
  if (!lu) {
    await setAdminState<LettersState>(env, user.telegram_id, "letters", { action: "await_nickname" });
    await sendMessage(
      env,
      chatId,
      `💌 <b>به بخش نامه‌ها خوش اومدی!</b>\n\n` +
        `اینجا با یه اسم مستعار و کاملاً ناشناس برای آدم‌های دیگه نامه می‌نویسی و جواب می‌گیری.\n\n` +
        `اول یه اسم مستعار برای خودت بنویس (همین رو بقیه می‌بینن، نه اسم واقعیت):`
    );
    return;
  }
  await showLettersMenu(env, user, chatId);
}

/** Show the letters home menu (reply keyboard) with an unread summary line. */
export async function showLettersMenu(env: Env, user: DbUser, chatId: number): Promise<void> {
  const unread = await countUnread(env, user.id);
  const unreadLine =
    unread > 0 ? `\n\n📬 <b>${faNum(unread)}</b> تا نامه/پاسخ جدید توی صندوقت داری.` : "";
  await sendMessage(
    env,
    chatId,
    `💌 <b>نامه‌ها</b>\n\n` +
      `اینجا می‌تونی با اسم مستعار نامه بنویسی، نامه بگیری و جواب بدی.\n` +
      `همه‌چیز ناشناسه، ساده‌ست و قراره شلوغش نکنیم.` +
      unreadLine,
    { reply_markup: getLettersMenuKeyboard() }
  );
}

/** Start the write-new-letter flow (validates quota & receiving state first). */
export async function startWriteLetter(env: Env, user: DbUser, chatId: number): Promise<void> {
  const lu = await getLetterUser(env, user.id);
  if (!lu) {
    await showLettersEntry(env, user, chatId);
    return;
  }

  if (isReceivingDisabled(lu)) {
    const left = disableLockRemainingMs(lu, Date.now());
    const lockLine = left > 0 ? `\nهنوز ${remainingText(left)} تا فعال‌سازی دوباره مونده.` : "";
    await sendMessage(
      env,
      chatId,
      `دریافت نامه‌هات غیرفعاله 💌\n` +
        `تا وقتی دریافت نامه رو فعال نکنی، نمی‌تونی نامه جدید بفرستی.${lockLine}`,
      { reply_markup: getLettersMenuKeyboard() }
    );
    return;
  }

  const todayCount = await countNewLettersToday(env, user.id);
  if (todayCount >= LETTERS.DAILY_NEW_LIMIT) {
    await sendMessage(
      env,
      chatId,
      `امروز ${faNum(LETTERS.DAILY_NEW_LIMIT)} تا نامه جدید فرستادی 💌\n` +
        `برای نامه جدید بعدی باید تا فردا صبر کنی.\n` +
        `ولی اگه کسی بهت جواب بده، می‌تونی بدون محدودیت جوابش رو بدی.`,
      { reply_markup: getLettersMenuKeyboard() }
    );
    return;
  }

  await setAdminState<LettersState>(env, user.telegram_id, "letters", { action: "await_letter_body" });
  await sendMessage(
    env,
    chatId,
    `✍️ <b>نوشتن نامه</b>\n\n` +
      `نامه‌ات رو بنویس و بفرست. حداقل ${faNum(LETTERS.BODY_MIN)} کاراکتر باشه تا واقعاً شبیه نامه بشه 🙂\n` +
      `هر موضوعی دوست داری می‌تونی بنویسی.`
  );
}

/** Show the inbox: unanswered letters (≤7 days) and unanswered replies. */
export async function showInbox(env: Env, user: DbUser, chatId: number): Promise<void> {
  const items = await getInbox(env, user.id);
  if (items.length === 0) {
    await sendMessage(env, chatId, `فعلا نامه‌ای برات نیومده 📭\nبعداً دوباره سر بزن.`, {
      reply_markup: getLettersMenuKeyboard(),
    });
    return;
  }

  const rows: InlineKeyboardButton[][] = items.map((m) => {
    const tag = m.is_reply === 1 ? "💬 پاسخ" : "💌 نامه";
    const unread = m.is_read === 0 ? "🟢 " : "";
    const label = `${unread}${tag} از «${m.sender_nickname}»`;
    return [{ text: label.slice(0, 60), callback_data: `${CB_PREFIX.LETTER_OPEN}:${m.id}` }];
  });

  await sendMessage(env, chatId, `📬 <b>نامه‌های رسیده</b>\n\nروی هرکدوم بزن تا بازش کنی 👇`, {
    reply_markup: { inline_keyboard: rows },
  });
}

/** Render an opened message (letter or reply) with reply/block/back actions. */
async function showMessage(env: Env, user: DbUser, chatId: number, messageId: number): Promise<void> {
  const msg = await getMessageForRecipient(env, messageId, user.id);
  if (!msg) {
    await sendMessage(env, chatId, `این نامه دیگه در دسترس نیست 📭`, { reply_markup: getLettersMenuKeyboard() });
    return;
  }
  if (!isInboxVisible(msg, Date.now())) {
    await sendMessage(env, chatId, `این نامه منقضی شده و دیگه قابل پاسخ نیست 📭`, {
      reply_markup: getLettersMenuKeyboard(),
    });
    return;
  }

  await markRead(env, messageId, user.id);

  let text: string;
  if (msg.is_reply === 1 && msg.ref_message_id != null) {
    const ref = await getMessageById(env, msg.ref_message_id);
    const refKind = ref && ref.is_reply === 1 ? "این پیام تو" : "نامه تو";
    const quote = ref ? snippet(ref.body) : "—";
    text =
      `💬 <b>پاسخ جدید از «${escapeHtml(msg.sender_nickname)}»</b>\n\n` +
      `در جواب ${refKind}:\n«${quote}»\n\n` +
      `${escapeHtml(msg.body)}`;
  } else {
    text = `💌 <b>نامه از «${escapeHtml(msg.sender_nickname)}»</b>\n\n${escapeHtml(msg.body)}`;
  }

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✍️ پاسخ دادن", callback_data: `${CB_PREFIX.LETTER_REPLY}:${msg.id}` }],
        [{ text: "🚫 بلاک کردن این شخص", callback_data: `${CB_PREFIX.LETTER_BLOCK}:${msg.id}` }],
        [{ text: "🔙 بازگشت", callback_data: `${CB_PREFIX.LETTER_INBOX}:1` }],
      ],
    },
  });
}

/** Show the letters settings screen with current status. */
export async function showSettings(env: Env, user: DbUser, chatId: number): Promise<void> {
  const lu = await getLetterUser(env, user.id);
  if (!lu) {
    await showLettersEntry(env, user, chatId);
    return;
  }

  const notifOn = lu.notif_enabled === 1;
  const disabled = isReceivingDisabled(lu);
  let receivingLine: string;
  if (disabled) {
    const left = disableLockRemainingMs(lu, Date.now());
    receivingLine =
      left > 0
        ? `🔕 دریافت نامه: <b>غیرفعال</b> (تا فعال‌سازی دوباره ${remainingText(left)} مونده)`
        : `🔕 دریافت نامه: <b>غیرفعال</b> (می‌تونی دوباره فعالش کنی)`;
  } else {
    receivingLine = `🔔 دریافت نامه: <b>فعال</b>`;
  }

  const text =
    `⚙️ <b>تنظیمات نامه‌ها</b>\n\n` +
    `🏷 اسم مستعار: <b>${escapeHtml(lu.nickname)}</b>\n` +
    `${notifOn ? "🔔" : "🔕"} نوتیفیکیشن: <b>${notifOn ? "روشن" : "خاموش"}</b>\n` +
    `${receivingLine}`;

  const receivingBtn: InlineKeyboardButton = disabled
    ? { text: "🔔 فعال‌کردن دریافت نامه", callback_data: `${CB_PREFIX.LETTER_DISABLE}:enable` }
    : { text: "🔕 غیرفعال‌کردن دریافت نامه", callback_data: `${CB_PREFIX.LETTER_DISABLE}:warn` };

  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🏷 تغییر اسم مستعار", callback_data: `${CB_PREFIX.LETTER_SETTINGS}:nick` }],
        [{ text: notifOn ? "🔕 خاموش‌کردن نوتیف" : "🔔 روشن‌کردن نوتیف", callback_data: `${CB_PREFIX.LETTER_NOTIF_TOGGLE}:1` }],
        [receivingBtn],
      ],
    },
  });
}

// ─────────────────────────────── notifications ───────────────────────────────

/** Proactively notify recipients of new letters (skips notif-disabled users). */
async function notifyNewLetters(env: Env, deliveries: LetterDelivery[]): Promise<void> {
  let sent = 0;
  for (const d of deliveries) {
    if (!d.notifEnabled) continue;
    try {
      await sendMessage(env, d.telegramId, `💌 یه نامه جدید داری`, {
        reply_markup: {
          inline_keyboard: [[{ text: "📬 باز کردن نامه", callback_data: `${CB_PREFIX.LETTER_OPEN_PROACTIVE}:${d.messageId}` }]],
        },
      });
    } catch (err) {
      console.error(`Letter notify failed for ${d.telegramId}:`, err);
    }
    if (++sent % 25 === 0) await sleep(100);
  }
}

/** Proactively notify the original sender of a new reply. */
async function notifyReply(env: Env, d: LetterDelivery, quote: string): Promise<void> {
  if (!d.notifEnabled) return;
  try {
    await sendMessage(
      env,
      d.telegramId,
      `💬 یه پاسخ جدید داری\n\nدر جواب:\n«${quote}»`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "📬 باز کردن پاسخ", callback_data: `${CB_PREFIX.LETTER_OPEN_PROACTIVE}:${d.messageId}` }]],
        },
      }
    );
  } catch (err) {
    console.error(`Reply notify failed for ${d.telegramId}:`, err);
  }
}

// ───────────────────────────── text-input dispatcher ─────────────────────────

/**
 * Consume free-text input for the letters flows (nickname / letter / reply).
 * Returns true if it handled the message. A tap on any registered menu button
 * cancels the flow and is handed back to the router (returns false).
 */
export async function handleLettersMessage(env: Env, user: DbUser, update: TelegramUpdate): Promise<boolean> {
  const message = update.message;
  const text = message?.text;
  if (!text) return false;

  const state = await getAdminState<LettersState>(env, user.telegram_id, "letters");
  if (!state) return false;

  const chatId = message!.chat.id;

  // A reply-keyboard button tap cancels the in-progress flow; let the router handle it.
  if (canonicalizeUserMenu(text) !== text) {
    await deleteAdminState(env, user.telegram_id, "letters");
    return false;
  }

  switch (state.action) {
    case "await_nickname":
    case "await_edit_nickname": {
      const res = validateNickname(text);
      if (!res.ok) {
        await sendMessage(env, chatId, res.reason);
        return true;
      }
      if (state.action === "await_nickname") {
        await createLetterUser(env, user.id, res.value);
      } else {
        await updateNickname(env, user.id, res.value);
      }
      await deleteAdminState(env, user.telegram_id, "letters");
      await sendMessage(env, chatId, `اسم مستعارت ثبت شد: «${escapeHtml(res.value)}» ✅`);
      await showLettersMenu(env, user, chatId);
      return true;
    }

    case "await_letter_body": {
      const res = validateLetterBody(text);
      if (!res.ok) {
        await sendMessage(env, chatId, res.reason);
        return true;
      }
      // Re-check receiving/quota at send time (guards races since the prompt).
      const lu = await getLetterUser(env, user.id);
      if (!lu || isReceivingDisabled(lu)) {
        await deleteAdminState(env, user.telegram_id, "letters");
        await sendMessage(env, chatId, `دریافت نامه‌هات غیرفعاله 💌 نمی‌تونی نامه جدید بفرستی.`, {
          reply_markup: getLettersMenuKeyboard(),
        });
        return true;
      }
      if ((await countNewLettersToday(env, user.id)) >= LETTERS.DAILY_NEW_LIMIT) {
        await deleteAdminState(env, user.telegram_id, "letters");
        await sendMessage(env, chatId, `امروز سهمیه‌ی نامه جدیدت تموم شده 💌 فردا دوباره می‌تونی.`, {
          reply_markup: getLettersMenuKeyboard(),
        });
        return true;
      }

      const deliveries = await sendNewLetter(env, user.id, lu.nickname, res.value);
      await deleteAdminState(env, user.telegram_id, "letters");

      if (deliveries.length === 0) {
        await sendMessage(
          env,
          chatId,
          `الان کسی برای دریافت نامه در دسترس نیست 🙃\nیه کم دیگه دوباره امتحان کن.`,
          { reply_markup: getLettersMenuKeyboard() }
        );
        return true;
      }

      await notifyNewLetters(env, deliveries);
      await sendMessage(env, chatId, `نامه‌ات فرستاده شد 💌\nاگه کسی جواب بده، همین‌جا بهت خبر می‌دم.`, {
        reply_markup: getLettersMenuKeyboard(),
      });
      return true;
    }

    case "await_reply_body": {
      const res = validateReplyBody(text);
      if (!res.ok) {
        await sendMessage(env, chatId, res.reason);
        return true;
      }
      const refId = state.refMessageId;
      await deleteAdminState(env, user.telegram_id, "letters");
      if (refId == null) {
        await sendMessage(env, chatId, `یه مشکلی پیش اومد 🙃 دوباره از صندوق نامه‌ها امتحان کن.`, {
          reply_markup: getLettersMenuKeyboard(),
        });
        return true;
      }

      const lu = await getLetterUser(env, user.id);
      const nickname = lu?.nickname ?? "ناشناس";
      const ref = await getMessageById(env, refId);
      const delivery = await sendReply(env, user.id, nickname, refId, res.value);
      if (!delivery) {
        await sendMessage(env, chatId, `این گفتگو دیگه در دسترس نیست 📭`, {
          reply_markup: getLettersMenuKeyboard(),
        });
        return true;
      }

      await notifyReply(env, delivery, ref ? snippet(ref.body) : "—");
      await sendMessage(env, chatId, `پاسخت فرستاده شد 💬`, { reply_markup: getLettersMenuKeyboard() });
      return true;
    }
  }

  return false;
}

// ─────────────────────────────── callback dispatcher ─────────────────────────

/** Dispatch all letters inline-button callbacks. Re-checks subscription/ban. */
export async function handleLettersCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
  const data = cb.data ?? "";
  const parts = data.split(":");
  const prefix = parts[0];
  const chatId = cb.message?.chat.id;

  if (!cb.from || chatId === undefined) {
    await answerCallbackQuery(env, cb.id);
    return;
  }

  const user = await getUserByTelegramId(env, cb.from.id);
  if (!user || !user.is_approved || user.is_banned) {
    await answerCallbackQuery(env, cb.id, "برای استفاده از نامه‌ها باید اشتراک فعال داشته باشی 🔒");
    return;
  }

  switch (prefix) {
    case CB_PREFIX.LETTERS_HOME: {
      await answerCallbackQuery(env, cb.id);
      await showLettersMenu(env, user, chatId);
      return;
    }

    case CB_PREFIX.LETTER_INBOX: {
      await answerCallbackQuery(env, cb.id);
      await showInbox(env, user, chatId);
      return;
    }

    case CB_PREFIX.LETTER_OPEN:
    case CB_PREFIX.LETTER_OPEN_PROACTIVE: {
      await answerCallbackQuery(env, cb.id);
      const id = Number(parts[1]);
      if (!Number.isFinite(id)) {
        await sendMessage(env, chatId, `این نامه دیگه در دسترس نیست 📭`);
        return;
      }
      await showMessage(env, user, chatId, id);
      return;
    }

    case CB_PREFIX.LETTER_REPLY: {
      const id = Number(parts[1]);
      const msg = Number.isFinite(id) ? await getMessageForRecipient(env, id, user.id) : null;
      if (!msg || !isInboxVisible(msg, Date.now())) {
        await answerCallbackQuery(env, cb.id, "این نامه دیگه قابل پاسخ نیست 📭");
        return;
      }
      if (await isBlockedEitherWay(env, user.id, msg.sender_user_id)) {
        await answerCallbackQuery(env, cb.id, "این گفتگو بسته شده 📭");
        return;
      }
      await answerCallbackQuery(env, cb.id);
      await setAdminState<LettersState>(env, user.telegram_id, "letters", {
        action: "await_reply_body",
        refMessageId: id,
      });
      await sendMessage(env, chatId, `✍️ پاسختت رو بنویس و بفرست:`);
      return;
    }

    case CB_PREFIX.LETTER_BLOCK: {
      const id = Number(parts[1]);
      const msg = Number.isFinite(id) ? await getMessageForRecipient(env, id, user.id) : null;
      if (!msg) {
        await answerCallbackQuery(env, cb.id, "این نامه دیگه در دسترس نیست 📭");
        return;
      }
      await answerCallbackQuery(env, cb.id);
      await sendMessage(
        env,
        chatId,
        `اگه این شخص رو بلاک کنی، دیگه ازش نامه‌ای برات نمیاد و این گفتگو هم بسته می‌شه.\nمطمئنی؟`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ بله، بلاک کن", callback_data: `${CB_PREFIX.LETTER_BLOCK_CONFIRM}:${msg.sender_user_id}:${id}` }],
              [{ text: "❌ نه، برگشت", callback_data: `${CB_PREFIX.LETTER_OPEN}:${id}` }],
            ],
          },
        }
      );
      return;
    }

    case CB_PREFIX.LETTER_BLOCK_CONFIRM: {
      const otherId = Number(parts[1]);
      if (!Number.isFinite(otherId)) {
        await answerCallbackQuery(env, cb.id);
        return;
      }
      await addBlock(env, user.id, otherId);
      await answerCallbackQuery(env, cb.id, "انجام شد");
      await sendMessage(env, chatId, `انجام شد. از این شخص دیگه نامه‌ای برات نمیاد. 🚫`, {
        reply_markup: getLettersMenuKeyboard(),
      });
      return;
    }

    case CB_PREFIX.LETTER_SETTINGS: {
      const sub = parts[1] ?? "";
      if (sub === "nick") {
        await answerCallbackQuery(env, cb.id);
        await setAdminState<LettersState>(env, user.telegram_id, "letters", { action: "await_edit_nickname" });
        await sendMessage(env, chatId, `🏷 اسم مستعار جدیدت رو بنویس:`);
        return;
      }
      await answerCallbackQuery(env, cb.id);
      await showSettings(env, user, chatId);
      return;
    }

    case CB_PREFIX.LETTER_NOTIF_TOGGLE: {
      const lu = await getLetterUser(env, user.id);
      if (!lu) {
        await answerCallbackQuery(env, cb.id);
        await showLettersEntry(env, user, chatId);
        return;
      }
      const newVal = lu.notif_enabled !== 1;
      await setNotifEnabled(env, user.id, newVal);
      await answerCallbackQuery(env, cb.id, newVal ? "نوتیف روشن شد 🔔" : "نوتیف خاموش شد 🔕");
      await showSettings(env, user, chatId);
      return;
    }

    case CB_PREFIX.LETTER_DISABLE: {
      const sub = parts[1] ?? "";
      const lu = await getLetterUser(env, user.id);
      if (!lu) {
        await answerCallbackQuery(env, cb.id);
        await showLettersEntry(env, user, chatId);
        return;
      }

      if (sub === "warn") {
        await answerCallbackQuery(env, cb.id);
        await sendMessage(
          env,
          chatId,
          `اگه دریافت نامه‌ها رو غیرفعال کنی:\n` +
            `• تا ${faNum(LETTERS.DISABLE_LOCK_DAYS)} روز نمی‌تونی دوباره فعالش کنی.\n` +
            `• توی این مدت نامه جدیدی برات نمیاد.\n` +
            `• خودت هم نمی‌تونی نامه جدید بفرستی.\n\nمطمئنی؟`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ بله، غیرفعال کن", callback_data: `${CB_PREFIX.LETTER_DISABLE}:yes` }],
                [{ text: "❌ نه، منصرف شدم", callback_data: `${CB_PREFIX.LETTER_SETTINGS}:open` }],
              ],
            },
          }
        );
        return;
      }

      if (sub === "yes") {
        await disableReceiving(env, user.id);
        await answerCallbackQuery(env, cb.id, "دریافت نامه غیرفعال شد");
        await showSettings(env, user, chatId);
        return;
      }

      if (sub === "enable") {
        const left = disableLockRemainingMs(lu, Date.now());
        if (!isReceivingDisabled(lu)) {
          await answerCallbackQuery(env, cb.id);
          await showSettings(env, user, chatId);
          return;
        }
        if (left > 0) {
          await answerCallbackQuery(
            env,
            cb.id,
            `دریافت نامه‌ها فعلاً غیرفعاله. ${remainingText(left)} تا فعال‌سازی دوباره مونده.`
          );
          return;
        }
        await enableReceiving(env, user.id);
        await answerCallbackQuery(env, cb.id, "دریافت نامه فعال شد 🔔");
        await showSettings(env, user, chatId);
        return;
      }

      await answerCallbackQuery(env, cb.id);
      return;
    }
  }

  await answerCallbackQuery(env, cb.id);
}

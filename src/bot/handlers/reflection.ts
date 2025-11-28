import { Env } from "../../types";
import { TelegramUpdate } from "../router";
import { sendMessage } from "../telegram-api";
import { getOrCreateUser } from "../../db/users";
import { 
  createReflectionSession, 
  getUserLearnedWords, 
  getPendingReflectionSession, 
  updateReflectionResult 
} from "../../db/reflection";
import { generateReflectionParagraph, evaluateReflection } from "../../ai/gemini";
import { getTrainingMenuKeyboard } from "../keyboards";

// شروع تمرین
export async function startReflectionForUser(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;
  const chatId = message.chat.id;
  const user = await getOrCreateUser(env, message.from);

  // چک کنیم اگر سشن باز دارد، اول آن را ببندد یا ادامه دهد
  const pending = await getPendingReflectionSession(env, user.id);
  if (pending) {
    await sendMessage(
      env,
      chatId,
      "⚠️ تو یک تمرین نیمه‌کاره داری. لطفاً اول برداشت خودت رو از متن قبلی بنویس تا بتونی جدید رو شروع کنی.\n\n" +
      "متن قبلی:\n" + pending.source_paragraph
    );
    return;
  }

  await sendMessage(env, chatId, "⏳ در حال آماده‌سازی متن اختصاصی برای تو...");

  // 1. کلمات کاربر را بگیر
  const words = await getUserLearnedWords(env, user.id, 5);
  
  // 2. تولید متن توسط AI
  const words = await getUserLearnedWords(env, user.id, 5);
  
  let paragraph: string;
  try {
    paragraph = await generateReflectionParagraph(env, words);
  } catch (error) {
    console.error("Reflection AI Error:", error);
    await sendMessage(env, chatId, "متاسفانه در ارتباط با هوش مصنوعی مشکلی پیش آمد. لطفاً کمی بعد تلاش کن ⚠️");
    return;
  }
  // =========================================

  // 3. ذخیره در دیتابیس
  await createReflectionSession(env, user.id, paragraph);

  // 4. ارسال به کاربر
  const text = 
    `📝 <b>تمرین برداشت از متن</b>\n\n` +
    `متن زیر رو بخون (شامل کلماتیه که یاد گرفتی):\n\n` +
    `<i>${paragraph}</i>\n\n` +
    `حالا برداشت یا خلاصه خودت رو به انگلیسی (یا فینگیلیش/فارسی اگه سخته) در قالب <b>یک پیام متنی</b> بفرست. \n` +
    `هوش مصنوعی بهت نمره و فیدبک میده!`;

  await sendMessage(env, chatId, text);
}

// هندل کردن پیامی که کاربر می‌فرستد (به عنوان جواب)
export async function handleReflectionAnswer(
  env: Env, 
  update: TelegramUpdate, 
  textMessage: string
): Promise<boolean> {
  const message = update.message;
  if (!message || !message.from) return false;
  
  const user = await getOrCreateUser(env, message.from);
  
  // چک کنیم آیا سشن باز دارد؟
  const session = await getPendingReflectionSession(env, user.id);
  if (!session) {
    return false; // یعنی این پیام مربوط به reflection نیست
  }

  // اگر پیام خیلی کوتاه باشد
  if (textMessage.length < 5) {
    await sendMessage(env, message.chat.id, "پاسخت خیلی کوتاهه! لطفاً کامل‌تر بنویس.");
    return true; // پیام هندل شد (جلوگیری از پاسخ‌های دیگر ربات)
  }

  await sendMessage(env, message.chat.id, "⏳ در حال تصحیح و تحلیل نوشته‌ی تو...");

  // ارزیابی با AI
  const result = await evaluateReflection(env, session.source_paragraph, textMessage);

  // ذخیره نتیجه
  await updateReflectionResult(env, session.id, textMessage, result.score, result.feedback);

  const reply = 
    `✅ نتیجه تمرین:\n\n` +
    `نمره: <b>${result.score}/10</b>\n\n` +
    `💡 فیدبک:\n${result.feedback}\n\n` +
    `خسته نباشی!`;

  await sendMessage(env, message.chat.id, reply, {
    reply_markup: getTrainingMenuKeyboard()
  });

  return true; // پیام با موفقیت به عنوان reflection هندل شد
}

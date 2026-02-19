import { Env } from "../../types";
import { TelegramUpdate } from "../router";
import { sendMessage } from "../telegram-api";
import { getOrCreateUser } from "../../db/users";
import { 
  createReflectionSession, 
  getUserLearnedWords, 
  getPendingReflectionSession, 
  updateReflectionResult,
  getTodayReflectionCount // <--- تغییر ۱: اضافه شدن این تابع به ایمپورت‌ها
} from "../../db/reflection";
import { generateReflectionParagraph, evaluateReflection } from "../../ai/gemini";
import { getTrainingMenuKeyboard } from "../keyboards";

// شروع تمرین
export async function startReflectionForUser(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.from) return;
  const chatId = message.chat.id;
  const user = await getOrCreateUser(env, message.from);

  // ۱. بررسی تمرین نیمه‌کاره (مثل قبل)
  // اگر کاربر قبلاً متنی گرفته و جواب نداده، بهش یادآوری می‌کنیم
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

  // ۲. بررسی محدودیت روزانه (بخش جدید اضافه شده)
  const todayCount = await getTodayReflectionCount(env, user.id);
  // اگر ۳ بار یا بیشتر استفاده کرده بود، جلوش رو می‌گیریم
  if (todayCount >= 3) {
    await sendMessage(
      env,
      chatId,
      "⛔️ سقف مجاز روزانه شما پر شده است!\n\n" +
      "شما در هر روز فقط می‌توانید ۳ بار از تمرین «برداشت از متن» استفاده کنید.\n" +
      "فردا دوباره منتظرت هستیم 👋"
    );
    return;
  }

  await sendMessage(env, chatId, "⏳ در حال آماده‌سازی متن روانشناسی اختصاصی برای تو...");

  // ۳. دریافت کلمات یادگرفته شده کاربر
  const words = await getUserLearnedWords(env, user.id, 5);
    
  // ۴. انتخاب سطح تصادفی (بخش جدید اضافه شده)
  const levels = ["A1", "A2", "B1", "B2"];
  const randomLevel = levels[Math.floor(Math.random() * levels.length)];

  let paragraph: string;
  try {
    // تابع generateReflectionParagraph حالا ۳ ورودی می‌گیرد: env, words, level
    // (مطمئن شو که فایل src/ai/gemini.ts رو هم طبق دستور قبلی آپدیت کرده باشی)
    paragraph = await generateReflectionParagraph(env, words, randomLevel);
  } catch (error) {
    console.error("Reflection AI Error:", error);
    await sendMessage(env, chatId, "متاسفانه در ارتباط با هوش مصنوعی مشکلی پیش آمد. لطفاً کمی بعد تلاش کن ⚠️");
    return;
  }

  // ۵. ذخیره در دیتابیس
  await createReflectionSession(env, user.id, paragraph);

  // ۶. ارسال به کاربر (با ذکر سطح و موضوع)
  const text = 
    `📝 <b>تمرین برداشت از متن (روانشناسی)</b>\n` +
    `سطح متن: <b>${randomLevel}</b>\n\n` +
    `متن زیر رو بخون:\n\n` +
    `<i>${paragraph}</i>\n\n` +
    `حالا برداشت یا خلاصه خودت رو به انگلیسی (یا فینگیلیش/فارسی اگه سخته) در قالب <b>یک پیام متنی</b> بفرست. \n` +
    `هوش مصنوعی بهت نمره و فیدبک میده!`;

  await sendMessage(env, chatId, text);
}

// هندل کردن پیامی که کاربر می‌فرستد (بدون تغییر نسبت به قبل)
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

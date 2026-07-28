import { Env } from "../../types";
import { TelegramCallbackQuery, InlineKeyboardButton } from "../types";
import { sendMessage, answerCallbackQuery, editMessageText } from "../telegram-api";
import { CB_PREFIX, TOURNAMENT_CONFIG } from "../../config/constants";
import { toPersianDigits } from "../../utils/digits";

/**
 * Comprehensive in-bot user guide ("راهنمای جامع ربات").
 *
 * Reached from the red reply-keyboard button on the main menu. It opens a single
 * message whose inline ("glassy") buttons list every user-facing section of the
 * bot. Tapping a section edits that same message to show the section's
 * explanation — split into short, readable PAGES navigated with بعدی/قبلی — so
 * the chat is never spammed with new messages. A «بازگشت به فهرست راهنما» button
 * always returns to the section list.
 *
 * Everything here is deliberately written for a reader who knows NOTHING about
 * the bot: friendly but composed tone, plain wording, and no ambiguity. Only
 * user-facing features are described — nothing about the admin panel.
 *
 * The page-building functions (buildHelpMenu / buildHelpTopicPage) are pure and
 * side-effect-free so the navigation logic (which button shows on which page)
 * is unit-testable without any Telegram or DB I/O.
 */

/** Sub-actions encoded in a help callback: `hlp:home` and `hlp:t:<key>:<page>`. */
export const HELP_ACTION = {
  HOME: "home",
  TOPIC: "t",
} as const;

interface HelpTopic {
  /** Stable short id used in callback_data (kept ASCII + tiny to stay well under Telegram's 64-byte limit). */
  key: string;
  /** Button label shown in the section list (leading emoji is intentional — it may be animated as a premium icon). */
  label: string;
  /** Page header shown above every page of the topic (HTML). */
  title: string;
  /** One HTML string per page. Every topic has at least one page. */
  pages: string[];
}

// ── Tournament wall-clock labels, derived from config so the guide can never
// drift from the real schedule. OPEN..LAST_JOIN is the join window; results land
// at CLOSE. Mirrors the labels the tournament handler itself shows.
const T_OPEN = toPersianDigits(`${String(TOURNAMENT_CONFIG.OPEN_HOUR).padStart(2, "0")}:00`);
const T_CLOSE = toPersianDigits(`${String(TOURNAMENT_CONFIG.CLOSE_HOUR).padStart(2, "0")}:00`);
const T_LAST_JOIN_MIN = TOURNAMENT_CONFIG.OPEN_HOUR * 60 + TOURNAMENT_CONFIG.JOIN_WINDOW_MINUTES;
const T_LAST_JOIN = toPersianDigits(
  `${String(Math.floor(T_LAST_JOIN_MIN / 60)).padStart(2, "0")}:${String(T_LAST_JOIN_MIN % 60).padStart(2, "0")}`
);
const T_QUESTIONS = toPersianDigits(TOURNAMENT_CONFIG.QUESTION_COUNT);
const T_DURATION = toPersianDigits(TOURNAMENT_CONFIG.DURATION_MINUTES);

/**
 * The full guide catalog. Order here is the order of buttons in the section list.
 * Kept as data (not scattered through handlers) so the whole guide reads top to
 * bottom in one place and is easy to extend.
 */
export const HELP_TOPICS: HelpTopic[] = [
  {
    key: "start",
    label: "🚀 از کجا شروع کنم",
    title: "🚀 <b>از کجا شروع کنم؟</b>",
    pages: [
      "سلام! 🌟 این ربات مثل یه مربی خصوصیِ زبان انگلیسیه که همیشه توی جیبته.\n\n" +
        "اینجا سه کار اصلی انجام می‌دی:\n" +
        "🧠 واژه یاد می‌گیری (با یه روش علمی و هوشمند که واژه‌ها یادت نره)\n" +
        "📖 درک مطلبت رو قوی می‌کنی\n" +
        "🏆 با بقیه رقابت می‌کنی و انگیزه می‌گیری\n\n" +
        "نکته‌ی طلایی: هر کار درستی که انجام بدی، <b>امتیاز (XP)</b> می‌گیری و پیشرفتت ثبت می‌شه. پس هیچ تلاشی هدر نمی‌ره! 💪",

      "همه‌چیز از <b>منوی پایین صفحه</b> شروع می‌شه — همون دکمه‌های ثابتی که زیر کادر تایپ پیام می‌بینی 👇\n\n" +
        "🎮 <b>تمرین‌ها:</b> قلب ربات؛ یادگیری واژه و تست درک مطلب\n" +
        "🏆 <b>لیدربورد:</b> جدول برترین‌ها\n" +
        "🎯 <b>مسابقه:</b> رقابت هیجان‌انگیز هر شب\n" +
        "🏅 <b>لیگ:</b> رقابت گروهی هفتگی\n" +
        "👤 <b>پروفایل و آمار:</b> کارنامه و تنظیمات تو\n" +
        "💌 <b>نامه‌ها:</b> گفتگوی ناشناس با بقیه\n\n" +
        "و هر وقت خواستی همه‌چیز رو یادت بیاد، همین دکمه‌ی قرمز <b>📖 راهنمای جامع ربات</b> رو بزن و برگرد اینجا.\n\n" +
        "آماده‌ای؟ برو سراغ 🎮 <b>تمرین‌ها</b> و اولین واژه‌ت رو یاد بگیر! 🚀",
    ],
  },
  {
    key: "xp",
    label: "⭐ امتیاز و زنجیره",
    title: "⭐ <b>امتیاز، زنجیره و سطح</b>",
    pages: [
      "<b>امتیاز (XP) چیه؟</b> ⭐\n\n" +
        "XP دقیقاً مثل امتیاز توی یه بازیه: هر کار درستی که توی ربات انجام بدی، بهت XP می‌ده.\n" +
        "✅ جواب درست توی لایتنر، درک مطلب، مسابقه… همه امتیاز دارن.\n\n" +
        "هرچی XP بیشتری جمع کنی:\n" +
        "🏆 توی لیدربورد بالاتر می‌ری\n" +
        "🏅 توی لیگ هفتگی صعود می‌کنی\n" +
        "🎖 مدال‌های بیشتری می‌گیری\n\n" +
        "خبر خوب: امتیاز کلّی تو هیچ‌وقت کم نمی‌شه؛ فقط بالا و بالاتر می‌ره. 📈",

      "<b>زنجیره‌ی مطالعه (Streak) چیه؟</b> 🔥\n\n" +
        "زنجیره یعنی چند <b>روز پشت‌سرهم</b> اومدی و مطالعه کردی.\n" +
        "هر روز که حداقل یه واژه رو درست جواب بدی، زنجیره‌ات یکی زیاد می‌شه.\n\n" +
        "⚠️ اما حواست باشه: اگه یه روز رو کامل غیبت بزنی، زنجیره صفر می‌شه و باید از اول بسازیش.\n\n" +
        "پس رازِ موفقیت خیلی ساده‌ست: <b>هر روز، حتی چند دقیقه!</b>\n" +
        "زنجیره‌های طولانی مدال‌های ویژه‌ی خودشون رو دارن. 🏅",

      "<b>سطح‌ها (Level) چی هستن؟</b> 📊\n\n" +
        "واژه‌ها بر اساس ترتیب و سختی، به چند <b>سطح</b> تقسیم شدن (سطح ۱ تا ۴).\n" +
        "سطح‌های پایین‌تر، واژه‌های ساده‌تر و پرکاربردترن — برای همین بهتره از اونجا شروع کنی.\n\n" +
        "موقع یادگیری واژه‌ی جدید، خودت انتخاب می‌کنی از کدوم سطح یا کدوم درس شروع کنی.\n\n" +
        "امتیاز هر واژه هم به سطحش بستگی داره: واژه‌های سطح بالاتر، XP بیشتری بهت می‌دن. ⭐",
    ],
  },
  {
    key: "leitner",
    label: "🧠 لایتنر واژگان",
    title: "🧠 <b>لایتنر واژگان</b>",
    pages: [
      "<b>لایتنر چیه؟</b> 🧠\n\n" +
        "لایتنر یه سیستم هوشمند برای یادگیری واژه‌ست که کمک می‌کنه واژه‌ها رو <b>ماندگار</b> به خاطر بسپاری.\n\n" +
        "رازش اینه: هر واژه رو دقیقاً <b>همون موقعی که داری فراموشش می‌کنی</b> دوباره بهت نشون می‌ده.\n" +
        "این‌جوری با کمترین تلاش، واژه‌ها توی حافظه‌ی بلندمدتت جا خوش می‌کنن.\n\n" +
        "<i>(ربات پشت پرده از یکی از پیشرفته‌ترین روش‌های علمیِ حافظه استفاده می‌کنه — تو فقط جواب بده، بقیه‌اش با ما.)</i>",

      "وقتی وارد 🧠 <b>لایتنر واژگان</b> می‌شی، تا سه گزینه می‌بینی:\n\n" +
        "📋 <b>مرور امروز:</b> واژه‌هایی که وقتِ مرورشون رسیده. مهم‌ترین کار روزانه‌ات همینه!\n\n" +
        "🆕 <b>واژه‌های جدید:</b> واژه‌های تازه برای یادگیری. می‌تونی به‌ترتیب کتاب، بر اساس درس، یا بر اساس سطح شروع کنی.\n\n" +
        "🔥 <b>واژه‌های سخت:</b> واژه‌هایی که چند بار اشتباه زدی و به تمرین بیشتر نیاز دارن.\n\n" +
        "<i>اگه یکی از این گزینه‌ها رو نمی‌بینی، یعنی الان توی اون بخش چیزی نداری — که خودش خبر خوبیه! 😊</i>",

      "<b>روند کار خیلی ساده‌ست:</b>\n\n" +
        "1️⃣ یه سوال چهارگزینه‌ای می‌بینی؛ گزینه‌ی درست رو بزن.\n" +
        "2️⃣ ربات جوابِ درست، معنی و توضیح واژه رو نشونت می‌ده.\n" +
        "3️⃣ بعد ازت می‌پرسه: «چقدر این واژه رو بلد بودی؟»\n\n" +
        "   🟢 <b>بلد بودم / آسون بود:</b> واژه دیرتر دوباره میاد.\n" +
        "   🔴 <b>سخت بود / بلد نبودم:</b> واژه زودتر برای مرور برمی‌گرده.\n\n" +
        "با خودت صادق باش! این انتخاب به ربات کمک می‌کنه بهترین زمانِ مرور رو برات پیدا کنه. 🎯",

      "چند دکمه‌ی کمکی هم موقع تمرین داری:\n\n" +
        "🤔 <b>نمی‌دونم:</b> اگه واژه رو بلد نیستی، به‌جای حدس زدن اینو بزن تا جوابش رو یاد بگیری.\n" +
        "🗑 <b>حذف واژه:</b> اگه واژه‌ای رو کاملاً بلدی و نمی‌خوای دیگه ببینیش، از چرخه‌ی مرور حذفش کن.\n" +
        "🎓 <b>خروج از واژه‌های سخت:</b> وقتی یه واژه‌ی سخت رو بالاخره یاد گرفتی.\n" +
        "🚩 <b>گزارش سوال:</b> اگه فکر می‌کنی سوال یا گزینه‌ای ایراد داره، گزارشش کن تا درستش کنیم.\n\n" +
        "هر وقت خواستی، با دکمه‌ی خروج بیرون میای و خلاصه‌ی کارِ امروزت رو می‌بینی. 👋",
    ],
  },
  {
    key: "reading",
    label: "📖 تست درک مطلب",
    title: "📖 <b>تست درک مطلب</b>",
    pages: [
      "<b>تست درک مطلب چیه؟</b> 📖\n\n" +
        "اینجا یه متن انگلیسی می‌خونی و بعد به چند سوال چهارگزینه‌ای درباره‌اش جواب می‌دی.\n\n" +
        "این تمرین کمکت می‌کنه:\n" +
        "📚 واژه‌ها رو توی دلِ جمله‌های واقعی یاد بگیری\n" +
        "🧩 سرعت و دقتِ خوندنت بالا بره\n" +
        "🎯 برای آزمون‌های واقعی آماده بشی",

      "<b>این تست کاملاً «آزمونی» برگزار می‌شه</b> (درست مثل یه امتحان واقعی):\n\n" +
        "▫️ اول یکی از متن‌ها رو از فهرست انتخاب می‌کنی.\n" +
        "▫️ همه‌ی سوال‌های اون متن، پشت‌سرهم و به‌ترتیب تصادفی میان.\n" +
        "▫️ وسط آزمون بهت نمی‌گیم جوابت درست بود یا غلط (تمرکزت نپره).\n" +
        "▫️ <b>آخرِ آزمون</b>، نتیجه‌ی کامل و پاسخنامه — همراه با توضیح هر سوال — رو یکجا می‌بینی.\n\n" +
        "اگه سوالی رو بلد نبودی، می‌تونی دکمه‌ی «بی‌جواب رد کن» رو بزنی و بری سراغ بعدی.",

      "💰 <b>امتیاز:</b>\n" +
        "هر جواب درست XP خوبی داره، و اگه عملکردت عالی باشه، <b>امتیاز جایزه</b> هم می‌گیری.\n\n" +
        "🚪 <b>انصراف:</b>\n" +
        "هر وقت خواستی می‌تونی با دکمه‌ی «انصراف و خروج» تست رو نیمه‌کاره رها کنی.\n\n" +
        "🌿 یه پیشنهاد کوچیک: یه متن انتخاب کن، با حوصله بخونش، بعد جواب بده. اینجا مسابقه‌ی سرعت نیست؛ با آرامش پیش برو. 😊",
    ],
  },
  {
    key: "board",
    label: "🏆 لیدربورد",
    title: "🏆 <b>لیدربورد</b>",
    pages: [
      "<b>لیدربورد (جدول برترین‌ها) چیه؟</b> 🏆\n\n" +
        "لیدربورد نشون می‌ده تو در مقایسه با بقیه‌ی زبان‌آموزها کجای کاری.\n\n" +
        "دو نوع لیدربورد داریم:\n" +
        "⭐ <b>لیدربورد امتیاز (XP):</b> بر اساس مجموع امتیازهایی که جمع کردی.\n" +
        "🔥 <b>لیدربورد زنجیره (Streak):</b> بر اساس تعداد روزهای متوالیِ مطالعه.",

      "<b>دوره‌های زمانی:</b>\n\n" +
        "لیدربورد امتیاز رو می‌تونی <b>هفتگی</b>، <b>ماهانه</b> یا <b>همیشگی</b> ببینی — پس حتی اگه تازه شروع کرده باشی، توی جدولِ هفتگی هم شانس داری بدرخشی! ✨\n\n" +
        "لیدربورد زنجیره هم دو حالت داره:\n" +
        "🔥 <b>زنجیره‌ی فعال</b> (زنجیره‌ی همین الانت)\n" +
        "🏅 <b>رکورد تاریخی</b> (بهترین رکوردی که تا حالا زدی)\n\n" +
        "توی هر جدول، ۵۰ نفرِ برتر و <b>رتبه‌ی خودت</b> رو هم می‌بینی.\n" +
        "📌 نکته: امتیاز تازه ممکنه چند دقیقه طول بکشه تا توی جدول بشینه — نگران نباش، ثبت شده!",
    ],
  },
  {
    key: "tourney",
    label: "🎯 مسابقه‌ی روزانه",
    title: "🎯 <b>مسابقه‌ی روزانه</b>",
    pages: [
      "<b>مسابقه‌ی روزانه چیه؟</b> 🎯\n\n" +
        "هر شب یه مسابقه‌ی هیجان‌انگیز برگزار می‌شه که همه با هم و هم‌زمان توش شرکت می‌کنن.\n\n" +
        `این مسابقه <b>${T_QUESTIONS}</b> سوال داره و باید سریع و دقیق جواب بدی.\n` +
        "هرچی جواب‌های درستت بیشتر باشه، رتبه‌ات بالاتره. 🏆",

      "⏰ <b>زمان‌بندی:</b>\n\n" +
        `ورود به مسابقه از ساعت <b>${T_OPEN}</b> تا <b>${T_LAST_JOIN}</b> بازه.\n` +
        `🏁 نتایج ساعت <b>${T_CLOSE}</b> اعلام می‌شه.\n\n` +
        `از لحظه‌ای که شروع می‌کنی، حدود <b>${T_DURATION} دقیقه</b> فرصت داری همه‌ی سوال‌ها رو جواب بدی، پس حواست جمع باشه.\n\n` +
        "دیر رسیدی؟ نگران نباش؛ تا آخرین لحظه‌ی پنجره‌ی ورود که بیای، بازم فرصتِ کامل برای جواب دادن داری. 👍",

      "💰 <b>امتیاز و جایزه:</b>\n\n" +
        "فقط با <b>شرکت کردن</b> XP می‌گیری، برای هر جواب درست هم امتیاز داری، و <b>نفرات برتر</b> جایزه‌ی ویژه می‌گیرن.\n\n" +
        "🥇🥈🥉 سه نفر اولِ هر شب روی سکو می‌رن و مدال می‌گیرن.\n\n" +
        "🔔 <b>می‌ترسی یادت بره؟</b> توی همون صفحه‌ی مسابقه دکمه‌ی «یادم بنداز» رو بزن تا هر شب سرِ ساعت بهت خبر بدم.\n\n" +
        "پس امشب حتماً بیا و شانست رو امتحان کن! 🎯",
    ],
  },
  {
    key: "league",
    label: "🏅 لیگ هفتگی",
    title: "🏅 <b>لیگ هفتگی</b>",
    pages: [
      "<b>لیگ هفتگی چیه؟</b> 🏅\n\n" +
        "لیگ یه رقابت گروهیِ هفتگیه. تو با یه گروه از افرادِ هم‌سطح خودت (یه «دیویژن») هم‌گروه می‌شی و در طول هفته با هم رقابت می‌کنین.\n\n" +
        "ملاکِ رقابت، <b>امتیازیه که اون هفته جمع می‌کنی</b> — از هر بخش ربات (لایتنر، درک مطلب، مسابقه…) که XP بگیری، توی لیگ هم به حساب میاد. پس کافیه فعال باشی!",

      "لیگ‌ها پله‌پله بالا می‌رن:\n" +
        "🥉 برنز → 🥈 نقره → 🥇 طلا → 💎 یاقوت → 💠 الماس\n\n" +
        "آخرِ هر هفته (شنبه):\n" +
        "🟢 نفراتِ <b>برتر</b> دیویژن، یه پله <b>صعود</b> می‌کنن.\n" +
        "🔴 نفراتِ <b>آخر</b>، یه پله <b>سقوط</b> می‌کنن.\n" +
        "⚪️ بقیه توی همون لیگ می‌مونن.\n\n" +
        "توی صفحه‌ی لیگ، کنارِ اسم هر نفر یه رنگ می‌بینی که وضعیتش (صعود/سقوط/ماندن) رو نشون می‌ده، و علامتِ 👈 هم اسمِ خودتو مشخص می‌کنه.",

      "👑 توی بالاترین لیگ (الماس)، نفراتِ اول <b>قهرمانِ هفته</b> می‌شن و مدالِ ویژه می‌گیرن.\n\n" +
        "🔄 هفته‌ی جدید از شنبه شروع می‌شه و امتیازِ لیگِ همه از نو صفر می‌شه — پس همیشه یه شروع تازه و یه فرصت دوباره داری.\n\n" +
        "🎯 رمزِ صعود ساده‌ست: هر روز یه‌کم فعالیت کن تا امتیاز هفتگی‌ت بالا بمونه.",
    ],
  },
  {
    key: "letters",
    label: "💌 نامه‌ها",
    title: "💌 <b>نامه‌ها</b>",
    pages: [
      "<b>نامه‌ها چیه؟</b> 💌\n\n" +
        "یه بخشِ دوست‌داشتنی و <b>کاملاً ناشناس</b> برای گفتگو با بقیه‌ی کاربرهای ربات.\n\n" +
        "تو با یه <b>اسم مستعار</b> نامه می‌نویسی؛ نامه‌ات برای چند نفرِ تصادفی فرستاده می‌شه و اونا می‌تونن جوابت رو بدن.\n\n" +
        "🕶 خیالت راحت باشه: هیچ‌کس اسم واقعی، شماره یا آیدیِ تلگرامت رو نمی‌بینه — فقط همون اسمِ مستعاری که خودت انتخاب می‌کنی.",

      "داخل 💌 <b>نامه‌ها</b> سه گزینه داری:\n\n" +
        "✍️ <b>نوشتن نامه:</b> یه نامه‌ی تازه بنویس تا برای چند نفرِ ناشناس بره.\n\n" +
        "📬 <b>نامه‌های رسیده:</b> صندوقِ ورودی‌ت؛ نامه‌های دیگران رو می‌خونی و می‌تونی جواب بدی.\n\n" +
        "⚙️ <b>تنظیمات:</b> اسمِ مستعارت رو عوض کن، اعلان‌ها رو خاموش/روشن کن، یا اگه خواستی دریافتِ نامه رو کلاً غیرفعال کن.",

      "چند نکته که تجربه‌ی همه خوب و امن بمونه:\n\n" +
        "✏️ نامه‌ها یه <b>حداقلِ طول</b> دارن تا معنادار باشن، و روزانه تعدادِ محدودی نامه‌ی جدید می‌تونی بفرستی.\n" +
        "🚫 اگه کسی مزاحمت شد، می‌تونی <b>بلاکش</b> کنی تا دیگه هیچ نامه‌ای بینتون رد و بدل نشه.\n" +
        "🙏 با احترام بنویس؛ پشتِ هر اسمِ مستعار، یه آدمِ واقعیه.\n" +
        "📮 نامه‌های خونده‌نشده بعد از مدتی پاک می‌شن، پس گاهی به صندوقت سر بزن.",
    ],
  },
  {
    key: "profile",
    label: "👤 پروفایل و تنظیمات",
    title: "👤 <b>پروفایل و تنظیمات</b>",
    pages: [
      "<b>پروفایل و آمار چیه؟</b> 👤\n\n" +
        "اینجا کارنامه و کارتِ شناساییِ تو توی رباته.\n" +
        "وقتی 👤 <b>پروفایل و آمار</b> رو بزنی، یه خلاصه از نامت، امتیازِ کل، زنجیره و آواتارت رو می‌بینی.\n\n" +
        "این بخش چهار قسمت داره که توی صفحه‌ی بعد معرفی‌شون می‌کنم 👇",

      "📊 <b>آمار فعالیت:</b> گزارشِ دقیقِ عملکردت (امروز، هفته، ماه یا کل). می‌بینی چند واژه جواب دادی، دقتت چقدر بوده و چقدر XP گرفتی.\n\n" +
        "🎖 <b>مدال‌ها:</b> نشان‌ها و جام‌هایی که گرفتی (بخشِ بعدیِ همین راهنما کاملشو توضیح می‌ده).\n\n" +
        "🪪 <b>خلاصه پروفایل:</b> کارتِ شناساییِ زبان‌آموزی‌ت، همراه با تاریخِ عضویت.\n\n" +
        "⚙️ <b>تنظیمات پروفایل:</b> شخصی‌سازیِ حساب (صفحه‌ی بعد).",

      "توی ⚙️ <b>تنظیمات پروفایل</b> می‌تونی:\n\n" +
        "🎭 <b>آواتار</b>ت رو عوض کنی — کافیه روی یکی از شکلک‌ها بزنی.\n\n" +
        "✏️ <b>نامِ نمایشی</b>ت رو تغییر بدی (همون اسمی که بقیه توی لیدربورد می‌بینن). برای این کار این دستور رو بفرست:\n" +
        "<code>/setname اسم_جدید</code>\n\n" +
        "⚠️ توجه: تغییرِ نام فقط <b>۳ بار</b> ممکنه و حداکثر ۳۲ حرف — پس با دقت انتخابش کن.",
    ],
  },
  {
    key: "medals",
    label: "🎖 مدال‌ها",
    title: "🎖 <b>مدال‌ها</b>",
    pages: [
      "<b>مدال‌ها چی هستن؟</b> 🎖\n\n" +
        "مدال‌ها نشان‌های افتخاری‌ان که برای دستاوردهات می‌گیری — مثل جام‌های یه قهرمان! 🏆\n\n" +
        "یه نکته‌ی مهم: مدال‌ها <b>امتیاز (XP) ندارن</b> و روی لیگ و لیدربورد اثری نمی‌ذارن؛ فقط برای افتخار و انگیزه‌ان.\n\n" +
        "هر مدالی که بگیری، همون لحظه بهت تبریک گفته می‌شه و توی بخشِ 🎖 <b>مدال‌ها</b> (داخل پروفایل) ذخیره می‌شه.",

      "مدال‌ها توی چند دسته‌ان:\n\n" +
        "🔥 <b>زنجیره:</b> برای مطالعه‌ی چند روز پشت‌سرهم (۷، ۳۰، ۱۰۰ روز و بیشتر).\n" +
        "⭐ <b>امتیاز:</b> برای رسیدن به پله‌های XP (مثلاً ۱۰۰۰، ۵۰۰۰، ۱۰٬۰۰۰…).\n" +
        "🧠 <b>واژگان:</b> برای تعدادِ واژه‌هایی که یاد می‌گیری.\n" +
        "📖 <b>درک مطلب:</b> برای تعدادِ تست‌هایی که کامل می‌کنی.\n" +
        "🎯 <b>مسابقه</b> و 🏅 <b>لیگ:</b> برای افتخاراتِ رقابتی، مثلِ قهرمانی و رسیدن به لیگ‌های بالا.\n\n" +
        "هرچی فعال‌تر باشی، کلکسیونِ مدال‌هات کامل‌تر می‌شه. برو برای گرفتنشون! 💪",
    ],
  },
];

/** Look up a topic by its stable key. */
export function helpTopicByKey(key: string): HelpTopic | undefined {
  return HELP_TOPICS.find((t) => t.key === key);
}

/** Clamp a (possibly out-of-range or non-integer) page index into [0, len-1]. */
function clampPage(page: number, len: number): number {
  if (!Number.isFinite(page)) return 0;
  const p = Math.trunc(page);
  if (p < 0) return 0;
  if (p > len - 1) return len - 1;
  return p;
}

interface HelpView {
  text: string;
  reply_markup: { inline_keyboard: InlineKeyboardButton[][] };
}

/**
 * Build the section-list ("home") view: a short welcome plus one glassy button
 * per topic, two per row in an alternating success/primary checkerboard so it
 * matches the rest of the bot's keyboards. Pure — no I/O.
 */
export function buildHelpMenu(): HelpView {
  const text =
    "📖 <b>راهنمای جامع ربات</b>\n" +
    "━━━━━━━━━━━━━━\n\n" +
    "به دنیای یادگیری زبان خوش اومدی! 🌟\n" +
    "اینجا هر بخشِ ربات رو ساده و کامل برات توضیح دادم — بدونِ هیچ ابهامی.\n\n" +
    "روی هر موضوعی که می‌خوای بدونی چیه و چطور کار می‌کنه بزن 👇";

  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < HELP_TOPICS.length; i += 2) {
    const row: InlineKeyboardButton[] = [];
    for (let col = 0; col < 2 && i + col < HELP_TOPICS.length; col++) {
      const idx = i + col;
      const topic = HELP_TOPICS[idx];
      const rowNo = i / 2;
      // Checkerboard so neither horizontal nor vertical neighbours share a colour.
      const style = (rowNo + col) % 2 === 0 ? "success" : "primary";
      row.push({
        text: topic.label,
        callback_data: `${CB_PREFIX.HELP}:${HELP_ACTION.TOPIC}:${topic.key}:0`,
        style,
      });
    }
    rows.push(row);
  }

  return { text, reply_markup: { inline_keyboard: rows } };
}

/**
 * Build the view for one page of one topic. Returns null for an unknown key so
 * the caller can silently ignore a stale/garbage callback. The page index is
 * clamped, so an out-of-range value never throws. Pure — no I/O.
 *
 * Button logic (this is what the unit tests pin down):
 *   - «صفحه قبل» appears only when not on the first page.
 *   - «صفحه بعد» appears only when not on the last page.
 *   - «بازگشت به فهرست راهنما» is always present.
 */
export function buildHelpTopicPage(key: string, page: number): HelpView | null {
  const topic = helpTopicByKey(key);
  if (!topic) return null;

  const total = topic.pages.length;
  const p = clampPage(page, total);

  let text = `${topic.title}\n━━━━━━━━━━━━━━\n\n${topic.pages[p]}`;
  if (total > 1) {
    text += `\n\n<i>📄 صفحه ${toPersianDigits(p + 1)} از ${toPersianDigits(total)}</i>`;
  }

  const nav: InlineKeyboardButton[] = [];
  if (p > 0) {
    nav.push({
      text: "◀️ صفحه قبل",
      callback_data: `${CB_PREFIX.HELP}:${HELP_ACTION.TOPIC}:${topic.key}:${p - 1}`,
      style: "primary",
    });
  }
  if (p < total - 1) {
    nav.push({
      text: "صفحه بعد ▶️",
      callback_data: `${CB_PREFIX.HELP}:${HELP_ACTION.TOPIC}:${topic.key}:${p + 1}`,
      style: "primary",
    });
  }

  const rows: InlineKeyboardButton[][] = [];
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: "🔙 بازگشت به فهرست راهنما", callback_data: `${CB_PREFIX.HELP}:${HELP_ACTION.HOME}` }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

/**
 * Entry point for the red "📖 راهنمای جامع ربات" reply-keyboard button. Sends the
 * section list as a fresh message; all later navigation edits that same message.
 * @param env - The worker environment containing the bot token
 * @param chatId - The Telegram chat ID to send the guide to
 * @returns void
 */
export async function showHelpHome(env: Env, chatId: number): Promise<void> {
  const view = buildHelpMenu();
  await sendMessage(env, chatId, view.text, { reply_markup: view.reply_markup });
}

/**
 * Handle every `hlp:*` callback: section list navigation and topic paging. Always
 * edits the existing message (no chat spam) and answers the callback query first
 * so the button's loading spinner stops immediately.
 * @param env - The worker environment containing the bot token
 * @param callbackQuery - The Telegram callback query from a guide inline button
 * @returns void
 */
export async function handleHelpCallback(env: Env, callbackQuery: TelegramCallbackQuery): Promise<void> {
  const message = callbackQuery.message;
  if (!message) {
    await answerCallbackQuery(env, callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;
  const messageId = message.message_id;

  // Stop the spinner right away — nothing below shows a toast/alert.
  await answerCallbackQuery(env, callbackQuery.id);

  const parts = (callbackQuery.data ?? "").split(":");
  const action = parts[1] ?? "";

  if (action === HELP_ACTION.HOME) {
    const view = buildHelpMenu();
    await editMessageText(env, chatId, messageId, view.text, { reply_markup: view.reply_markup });
    return;
  }

  if (action === HELP_ACTION.TOPIC) {
    const key = parts[2] ?? "";
    const page = Number(parts[3] ?? "0");
    const view = buildHelpTopicPage(key, page);
    if (!view) return; // unknown topic — spinner already stopped, nothing to show
    await editMessageText(env, chatId, messageId, view.text, { reply_markup: view.reply_markup });
    return;
  }
}

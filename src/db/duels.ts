import { Env } from "../types";
import { queryOne, queryAll, execute, prepare } from "./client";
import { addXpForDuelMatch, checkAndUpdateStreak } from "./xp";
import { generateWordQuestionsWithGemini } from "../ai/gemini";
import { insertWordQuestions } from "./word_questions";
// اضافه شدن ایمپورت‌های جدید برای ارسال پیام
import { getUserById } from "./users"; 
import { sendMessage } from "../bot/telegram-api";

export type DuelDifficulty = "easy" | "hard";

export interface DuelMatch {
  id: number;
  difficulty: string;
  status: string;
  player1_id: number;
  player2_id: number | null;
  winner_user_id: number | null;
  is_draw: number;
  player1_correct: number;
  player2_correct: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface DuelQuestionFull {
  duel_question_id: number;
  duel_id: number;
  question_index: number;
  word_id: number;
  word_question_id: number;
  english: string;
  persian: string;
  level: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
}

export interface DuelFinalizeResult {
  completed: boolean;
  totalQuestions: number;
  player1Correct: number;
  player2Correct: number;
  winnerUserId: number | null;
  isDraw: boolean;
  match: DuelMatch;
}

const QUESTION_COUNT = 5;

export async function getDuelMatchById(env: Env, id: number): Promise<DuelMatch | null> {
  return await queryOne<DuelMatch>(env, `SELECT * FROM duel_matches WHERE id = ?`, [id]);
}

export async function findWaitingMatch(env: Env, difficulty: DuelDifficulty, userId: number): Promise<DuelMatch | null> {
  return await queryOne<DuelMatch>(
    env,
    `SELECT * FROM duel_matches WHERE difficulty = ? AND status = 'waiting' AND player2_id IS NULL AND player1_id <> ? ORDER BY created_at ASC LIMIT 1`,
    [difficulty, userId]
  );
}

export async function createDuelMatch(env: Env, difficulty: DuelDifficulty, userId: number): Promise<DuelMatch> {
  const now = new Date().toISOString();
  await execute(
    env,
    `INSERT INTO duel_matches (difficulty, status, player1_id, created_at, started_at) VALUES (?, 'waiting', ?, ?, ?)`,
    [difficulty, userId, now, now]
  );
  const m = await queryOne<DuelMatch>(
    env,
    `SELECT * FROM duel_matches WHERE player1_id = ? AND difficulty = ? ORDER BY id DESC LIMIT 1`,
    [userId, difficulty]
  );
  if (!m) throw new Error("Failed to create duel match");
  return m;
}

export async function joinDuelMatch(env: Env, matchId: number, userId: number): Promise<DuelMatch | null> {
  const now = new Date().toISOString();
  // Atomic Update: فقط اگر player2_id خالی است، آن را پر کن
  const result = await execute(
    env,
    `UPDATE duel_matches SET player2_id = ?, status = 'in_progress', started_at = ? WHERE id = ? AND player2_id IS NULL`,
    [userId, now, matchId]
  );

  if (result?.meta?.changes === 0) {
    return null;
  }

  const m = await getDuelMatchById(env, matchId);
  if (!m) throw new Error("Failed to join duel match");
  return m;
}

export async function ensureDuelQuestions(env: Env, matchId: number, difficulty: DuelDifficulty): Promise<void> {
  // تعداد سوالات فعلی را چک می‌کنیم
  const totalQ = await getTotalQuestionsInMatch(env, matchId);
  // اگر قبلاً ۵ تا سوال ساخته شده، نیازی به کار اضافه نیست
  if (totalQ >= QUESTION_COUNT) return;

  const levelCond = difficulty === "easy" ? "AND level IN (1, 2)" : "AND level BETWEEN 1 AND 4";

  // حلقه برای ساخت سوالات از شماره ۱ تا ۵
  for (let idx = 1; idx <= QUESTION_COUNT; idx++) {
    
    // ۱. چک می‌کنیم آیا سوال شماره idx (مثلاً ۳) الان وجود دارد؟
    const existing = await queryOne<{ id: number }>(
      env,
      `SELECT id FROM duel_questions WHERE duel_id = ? AND question_index = ?`,
      [matchId, idx]
    );

    // اگر وجود داشت، می‌رویم سراغ شماره بعدی
    if (existing) continue;

    // ۲. تلاش برای ساخت سوال (با مکانیزم تلاش مجدد)
    // اینجا تغییر اصلی است: تا ۳ بار تلاش می‌کنیم این جایگاه خالی را پر کنیم
    let added = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        
        // الف) انتخاب یک کلمه تصادفی (روش بهینه شده: LIMIT OFFSET)
        // 1. اول تعداد کل کلمات واجد شرایط را می‌گیریم
        const countRow = await queryOne<{ cnt: number }>(
            env,
            `SELECT COUNT(*) as cnt FROM words WHERE is_active = 1 ${levelCond}`
        );
        const totalWords = countRow?.cnt || 0;

        let wordRow = null;
        if (totalWords > 0) {
            // 2. یک آفست تصادفی تولید می‌کنیم
            const randomOffset = Math.floor(Math.random() * totalWords);
            
            // 3. فقط همان یک کلمه را می‌گیریم (بدون سورت سنگین)
            wordRow = await queryOne<{ id: number; english: string; persian: string; level: number }>(
                env,
                `SELECT id, english, persian, level FROM words WHERE is_active = 1 ${levelCond} LIMIT 1 OFFSET ?`,
                [randomOffset]
            );
        }

        if (!wordRow) break; // اگر دیتابیس کلمات خالی باشد، کاری نمی‌شود کرد

        // ب) انتخاب یک سوال آماده برای آن کلمه
        let qRow = await queryOne<{ id: number }>(
            env,
            `SELECT id FROM word_questions WHERE word_id = ? ORDER BY RANDOM() LIMIT 1`,
            [wordRow.id]
        );

        // پ) اگر سوال آماده نداشتیم، با هوش مصنوعی می‌سازیم
        if (!qRow) {
            try {
                const styles = ["fa_meaning", "en_definition", "synonym", "antonym"];
                const randomStyle = styles[Math.floor(Math.random() * styles.length)];

                const aiQuestions = await generateWordQuestionsWithGemini({
                    env,
                    english: wordRow.english,
                    persian: wordRow.persian,
                    level: wordRow.level,
                    questionStyle: randomStyle,
                    count: 1
                });

                if (aiQuestions.length > 0) {
                    // === کد جدید: جایگزینی معنی فارسی دقیق در دوئل ===
                    const finalDuelQuestions = aiQuestions.map((q) => {
                        if (randomStyle === "fa_meaning") {
                            q.options[q.correctIndex] = wordRow.persian;
                        }
                        return {
                            wordId: wordRow.id,
                            questionText: q.question,
                            options: q.options,
                            correctIndex: q.correctIndex,
                            explanation: q.explanation,
                            questionStyle: randomStyle
                        };
                    });

                    await insertWordQuestions(
                        env,
                        wordRow.id,
                        finalDuelQuestions
                    );

                    // دوباره سوال ساخته شده را از دیتابیس می‌گیریم
                    qRow = await queryOne<{ id: number }>(
                        env,
                        `SELECT id FROM word_questions WHERE word_id = ? ORDER BY id DESC LIMIT 1`,
                        [wordRow.id]
                    );
                }
            } catch (err) {
                console.error("Failed to auto-generate duel question:", err);
            }
        }

        // ت) اگر سوال پیدا یا ساخته شد، آن را ثبت می‌کنیم
        if (qRow) {
            await execute(
                env,
                `INSERT OR IGNORE INTO duel_questions (duel_id, question_index, word_id, word_question_id) VALUES (?, ?, ?, ?)`,
                [matchId, idx, wordRow.id, qRow.id]
            );
            added = true;
            break; // موفقیت! از حلقه تلاش خارج می‌شویم و می‌رویم سراغ سوال بعدی (idx بعدی)
        }
        // اگر نرسیدیم اینجا، یعنی تلاش ناموفق بود. حلقه attempt دوباره اجرا می‌شود.
    }
  }
}

export async function getTotalQuestionsInMatch(env: Env, duelId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_questions WHERE duel_id = ?`, [duelId]);
  return row?.cnt ?? 0;
}

export async function getUserAnswerCountInMatch(env: Env, duelId: number, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_answers WHERE duel_id = ? AND user_id = ?`, [duelId, userId]);
  return row?.cnt ?? 0;
}

export async function getDuelQuestionByIndex(env: Env, duelId: number, questionIndex: number): Promise<DuelQuestionFull | null> {
  return await queryOne<DuelQuestionFull>(
    env,
    `SELECT dq.id AS duel_question_id, dq.duel_id, dq.question_index, w.id AS word_id, wq.id AS word_question_id, w.english, w.persian, w.level, wq.question_text, wq.option_a, wq.option_b, wq.option_c, wq.option_d, wq.correct_option FROM duel_questions dq JOIN word_questions wq ON dq.word_question_id = wq.id JOIN words w ON dq.word_id = w.id WHERE dq.duel_id = ? AND dq.question_index = ?`,
    [duelId, questionIndex]
  );
}

export async function getDuelQuestionById(env: Env, duelQuestionId: number): Promise<DuelQuestionFull | null> {
  return await queryOne<DuelQuestionFull>(
    env,
    `SELECT dq.id AS duel_question_id, dq.duel_id, dq.question_index, w.id AS word_id, wq.id AS word_question_id, w.english, w.persian, w.level, wq.question_text, wq.option_a, wq.option_b, wq.option_c, wq.option_d, wq.correct_option FROM duel_questions dq JOIN word_questions wq ON dq.word_question_id = wq.id JOIN words w ON dq.word_id = w.id WHERE dq.id = ?`,
    [duelQuestionId]
  );
}

export function prepareRecordDuelAnswer(
  env: Env,
  duelId: number,
  duelQuestionId: number,
  userId: number,
  chosenOption: string,
  isCorrect: boolean
): any {
  const now = new Date().toISOString();
  return prepare(
    env,
    `INSERT INTO duel_answers (duel_id, duel_question_id, user_id, chosen_option, is_correct, answered_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [duelId, duelQuestionId, userId, chosenOption, isCorrect ? 1 : 0, now]
  );
}

export async function recordDuelAnswer(env: Env, duelId: number, duelQuestionId: number, userId: number, chosenOption: string, isCorrect: boolean): Promise<void> {
  const stmt = prepareRecordDuelAnswer(env, duelId, duelQuestionId, userId, chosenOption, isCorrect);
  await env.DB.batch([stmt]);
}

export async function getUserCorrectCountInMatch(env: Env, duelId: number, userId: number): Promise<number> {
  const row = await queryOne<{ cnt: number }>(env, `SELECT COUNT(*) AS cnt FROM duel_answers WHERE duel_id = ? AND user_id = ? AND is_correct = 1`, [duelId, userId]);
  return row?.cnt ?? 0;
}

export async function maybeFinalizeMatch(env: Env, duelId: number): Promise<DuelFinalizeResult | null> {
  let match = await getDuelMatchById(env, duelId);
  if (!match) return null;
  if (match.status === "completed") return null;
  if (!match.player1_id || !match.player2_id) return null;

  const totalQuestions = await getTotalQuestionsInMatch(env, duelId);
  if (totalQuestions === 0) return null;

  const p1Answers = await getUserAnswerCountInMatch(env, duelId, match.player1_id);
  const p2Answers = await getUserAnswerCountInMatch(env, duelId, match.player2_id);

  if (p1Answers < totalQuestions || p2Answers < totalQuestions) return null;

  const player1Correct = await getUserCorrectCountInMatch(env, duelId, match.player1_id);
  const player2Correct = await getUserCorrectCountInMatch(env, duelId, match.player2_id);

  let winnerUserId: number | null = null;
  let isDraw = 0;

  if (player1Correct > player2Correct) { winnerUserId = match.player1_id; isDraw = 0; }
  else if (player2Correct > player1Correct) { winnerUserId = match.player2_id; isDraw = 0; }
  else { winnerUserId = null; isDraw = 1; }

  const now = new Date().toISOString();

  const result = await execute(
    env,
    `UPDATE duel_matches SET status = 'completed', player1_correct = ?, player2_correct = ?, winner_user_id = ?, is_draw = ?, completed_at = ? WHERE id = ? AND status != 'completed'`,
    [player1Correct, player2Correct, winnerUserId, isDraw, now, duelId]
  );

  if (result?.meta?.changes === 0) return null;

  match = await getDuelMatchById(env, duelId);
  if (!match) throw new Error("Duel match disappeared after finalize");

  return {
    completed: true,
    totalQuestions,
    player1Correct,
    player2Correct,
    winnerUserId,
    isDraw: match.is_draw === 1,
    match
  };
}

// === این بخش کاملاً تغییر کرده است ===
export async function cleanupOldMatches(env: Env): Promise<void> {
  // 1. پیدا کردن بازی‌هایی که بیش از ۱ ساعت در وضعیت in_progress مانده‌اند
  const stuckMatches = await queryAll<DuelMatch>(
  env,
  `SELECT * FROM duel_matches 
   WHERE status = 'in_progress' 
   AND started_at < datetime('now', '-1 hour')
   LIMIT 50` // <--- این خط اضافه شد
);

  for (const match of stuckMatches) {
    // آمار پاسخ‌ها را می‌گیریم
    const p1Answers = await getUserAnswerCountInMatch(env, match.id, match.player1_id);
    const p2Answers = match.player2_id ? await getUserAnswerCountInMatch(env, match.id, match.player2_id) : 0;

    // اگر هیچکدام حتی یک جواب هم نداده‌اند -> بازی کنسل می‌شود (بدون XP و پیام)
    if (p1Answers === 0 && p2Answers === 0) {
       await execute(env, `UPDATE duel_matches SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`, [match.id]);
       continue; 
    }

    // محاسبه نتیجه بر اساس پاسخ‌های موجود
    const p1Correct = await getUserCorrectCountInMatch(env, match.id, match.player1_id);
    const p2Correct = match.player2_id ? await getUserCorrectCountInMatch(env, match.id, match.player2_id) : 0;
    
    let winnerUserId: number | null = null;
    let isDraw = 0;
    
    // مقایسه ساده
    if (p1Correct > p2Correct) {
       winnerUserId = match.player1_id;
       isDraw = 0;
    } else if (p2Correct > p1Correct) {
       winnerUserId = match.player2_id;
       isDraw = 0;
    } else {
       // اگر مساوی باشند یا هر دو صفر باشند
       winnerUserId = null;
       isDraw = 1;
    }

    const now = new Date().toISOString();

    // بستن بازی در دیتابیس
    await execute(
      env,
      `UPDATE duel_matches 
       SET status = 'completed', 
           player1_correct = ?, 
           player2_correct = ?, 
           winner_user_id = ?, 
           is_draw = ?, 
           completed_at = ? 
       WHERE id = ?`,
      [p1Correct, p2Correct, winnerUserId, isDraw, now, match.id]
    );

    const totalQ = 5; 

    // === اطلاع‌رسانی به بازیکنان ===
    // فقط به کسانی پیام می‌دهیم که حداقل ۱ جواب داده باشند

    const p1 = await getUserById(env, match.player1_id);
    const p2 = match.player2_id ? await getUserById(env, match.player2_id) : null;

    if (p1 && p1Answers > 0) {
        let p1Result: "win" | "draw" | "lose" = "lose";
        if (isDraw) p1Result = "draw";
        else if (winnerUserId === match.player1_id) p1Result = "win";
        
        const xp = await addXpForDuelMatch(env, match.player1_id, match.id, p1Correct, totalQ, p1Result);
        const streakMsg = await checkAndUpdateStreak(env, match.player1_id);

        let msg = `⌛️ مهلت بازی تمام شد (حریف پاسخ نداد).\n\n`;
        msg += p1Result === 'win' ? "🏆 تو بردی!" : (p1Result === 'draw' ? "🤝 مساوی شد." : "❌ باختی.");
        msg += `\n✅ امتیاز تو: ${p1Correct}\n👤 امتیاز حریف: ${p2Correct}`;
        if (xp > 0) msg += `\n⭐️ XP دریافتی: ${xp}`;
        if (streakMsg) msg += `\n\n${streakMsg}`;

        await sendMessage(env, p1.telegram_id, msg);
    }

    if (p2 && p2Answers > 0) {
       let p2Result: "win" | "draw" | "lose" = "lose";
       if (isDraw) p2Result = "draw";
       else if (winnerUserId === match.player2_id) p2Result = "win";
       
       const xp = await addXpForDuelMatch(env, match.player2_id, match.id, p2Correct, totalQ, p2Result);
       const streakMsg = await checkAndUpdateStreak(env, match.player2_id);

       let msg = `⌛️ مهلت بازی تمام شد.\n\n`;
       msg += p2Result === 'win' ? "🏆 تو بردی!" : (p2Result === 'draw' ? "🤝 مساوی شد." : "❌ باختی.");
       msg += `\n✅ امتیاز تو: ${p2Correct}\n👤 امتیاز حریف: ${p1Correct}`;
       if (xp > 0) msg += `\n⭐️ XP دریافتی: ${xp}`;
       if (streakMsg) msg += `\n\n${streakMsg}`;

       await sendMessage(env, p2.telegram_id, msg);
    }
  }

  // 2. پاکسازی کامل دوئل‌های 'waiting' خیلی قدیمی
  await execute(
    env,
    `DELETE FROM duel_answers 
     WHERE duel_id IN (
       SELECT id FROM duel_matches 
       WHERE status = 'waiting' AND created_at < datetime('now', '-3 days')
     )`
  );

  await execute(
    env,
    `DELETE FROM duel_questions 
     WHERE duel_id IN (
       SELECT id FROM duel_matches 
       WHERE status = 'waiting' AND created_at < datetime('now', '-3 days')
     )`
  );

  await execute(
    env,
    `DELETE FROM duel_matches 
     WHERE status = 'waiting' AND created_at < datetime('now', '-3 days')`
  );
}

export async function quitActiveMatch(env: Env, userId: number): Promise<void> {
  // ۱. پیدا کردن بازی فعال یا در انتظار کاربر
  const match = await queryOne<DuelMatch>(
    env,
    `SELECT * FROM duel_matches 
     WHERE (player1_id = ? OR player2_id = ?) 
     AND status IN ('waiting', 'in_progress')`,
    [userId, userId]
  );

  if (!match) return; 

  // حالت الف: بازی در وضعیت انتظار است (هنوز حریف پیدا نشده)
  // راه حل: حذف کامل رکوردها برای جلوگیری از ایجاد بازی‌های روح (Ghost Matches)
  if (match.status === 'waiting') {
      // اول حذف جواب‌های احتمالی (اگر کاربر حین انتظار جواب داده باشد)
      await execute(env, `DELETE FROM duel_answers WHERE duel_id = ?`, [match.id]);
      // دوم حذف سوالات ساخته شده برای این بازی
      await execute(env, `DELETE FROM duel_questions WHERE duel_id = ?`, [match.id]);
      // سوم حذف خودِ بازی
      await execute(env, `DELETE FROM duel_matches WHERE id = ?`, [match.id]);
      return;
  }

  // حالت ب: بازی در جریان است (حریف دارد)
  // راه حل: کاربر انصراف داده، پس بازی تمام می‌شود و حریف برنده اعلام می‌شود.
  const now = new Date().toISOString();
  
  let winnerId: number | null = null;
  // برنده نفر مقابل است
  winnerId = match.player1_id === userId ? match.player2_id : match.player1_id;

  await execute(
    env,
    `UPDATE duel_matches 
     SET status = 'completed', 
         winner_user_id = ?, 
         completed_at = ? 
     WHERE id = ?`,
    [winnerId, now, match.id]
  );
}

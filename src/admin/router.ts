import { Env } from "../types";
import { queryAll, queryOne, execute } from "../db/client";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../utils/response";
import { renderAdminLayout, renderWordForm, renderTextForm, renderUserForm } from "./views";
import { insertWordQuestions } from "../db/word_questions";

// === Rate Limiting برای ورود ادمین ===
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const RATE_LIMIT_MAX = 5;        // حداکثر تلاش
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // ۱۵ دقیقه

function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= RATE_LIMIT_MAX;
}

function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    record.count++;
  }
}
// ==========================================

type QuestionFormPayload = {
  questionText: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: "A" | "B" | "C" | "D";
  questionStyle: string;
  explanationText: string | null;
  source: "manual";
};

function parseAndValidateQuestionForm(form: FormData): { error?: string; data?: QuestionFormPayload } {
  const questionText = (form.get("question_text") || "").toString().trim();
  const optionA = (form.get("option_a") || "").toString().trim();
  const optionB = (form.get("option_b") || "").toString().trim();
  const optionC = (form.get("option_c") || "").toString().trim();
  const optionD = (form.get("option_d") || "").toString().trim();
  const correctOptionRaw = (form.get("correct_option") || "").toString().trim().toUpperCase();
  const questionStyle = ((form.get("question_style") || form.get("question_type") || "").toString().trim());
  const explanationText = (form.get("explanation_text") || "").toString().trim() || null;
  const source = (form.get("source") || "").toString().trim();

  if (!questionText) return { error: "متن سوال الزامی است." };
  if (!optionA || !optionB || !optionC || !optionD) return { error: "تمام گزینه‌های A تا D الزامی هستند." };
  if (!["A", "B", "C", "D"].includes(correctOptionRaw)) return { error: "گزینه صحیح باید یکی از A/B/C/D باشد." };
  if (!questionStyle) return { error: "فیلد نوع/سبک سوال الزامی است." };
  if (source !== "manual") return { error: "منبع سوال باید manual باشد." };

  return {
    data: {
      questionText,
      optionA,
      optionB,
      optionC,
      optionD,
      correctOption: correctOptionRaw as "A" | "B" | "C" | "D",
      questionStyle,
      explanationText,
      source: "manual"
    }
  };
}

function getQuestionRedirectPath(type: "word" | "text", parentId: number, returnTo: string): string {
  if (returnTo === "edit") {
    return type === "word" ? `/admin/words/edit?id=${parentId}` : `/admin/texts/edit?id=${parentId}`;
  }
  return type === "word" ? `/admin/words/questions?word_id=${parentId}` : `/admin/texts/questions?text_id=${parentId}`;
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const parts = cookie.split(";").map((c) => c.trim());
  for (const part of parts) {
    if (part.startsWith(name + "=")) {
      return decodeURIComponent(part.substring(name.length + 1));
    }
  }
  return null;
}

async function isAdminAuthed(request: Request, env: Env): Promise<boolean> {
  const token = getCookie(request, "admin_token");
  if (!token) return false;
  const session = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')`,
    [token]
  );
  return !!session;
}

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // === لایه امنیتی جدید: محافظت CSRF ===
  if (request.method === "POST") {
    const origin = request.headers.get("Origin");
    const referer = request.headers.get("Referer");
    
    if (origin && new URL(origin).hostname !== url.hostname) {
      return new Response("Forbidden (CSRF Origin Mismatch)", { status: 403 });
    }
    if (!origin && referer && new URL(referer).origin !== url.origin) {
      return new Response("Forbidden (CSRF Referer Mismatch)", { status: 403 });
    }
  }

  // 1. لاگین و احراز هویت اولیه
  if (url.pathname === "/admin") {
    if (await isAdminAuthed(request, env)) {
      return redirect("/admin/words");
    }
    const content = `
      <p>رمز عبور ادمین را وارد کن.</p>
      <form method="post" action="/admin/login">
        <label for="password">رمز عبور:</label>
        <input id="password" type="password" name="password" />
        <button type="submit">ورود</button>
      </form>
    `;
    return htmlResponse(renderAdminLayout("ورود به پنل ادمین", content, "home"));
  }

  if (request.method === "POST" && url.pathname === "/admin/login") {
    const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    
    if (isLoginRateLimited(clientIp)) {
      const content = `<div class="error">تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر تلاش کنید.</div>`;
      return htmlResponse(renderAdminLayout("محدودیت ورود", content, "home"), 429);
    }

    const form = await parseForm(request);
    const password = (form.get("password") || "").toString();
    const expected = env.ADMIN_PASSWORD || "";

    if (!expected || password !== expected) {
      recordLoginAttempt(clientIp);
      const content = `
        <div class="error">رمز عبور اشتباه است یا تنظیم نشده.</div>
        <form method="post" action="/admin/login">
          <label for="password">رمز عبور:</label>
          <input id="password" type="password" name="password" />
          <button type="submit">ورود</button>
        </form>
      `;
      return htmlResponse(renderAdminLayout("ورود به پنل ادمین", content, "home"), 401);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    await execute(env, "INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)", [token, expiresAt]);
    
    const headers = new Headers();
    headers.append("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
    headers.append("Location", "/admin/words");
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === "/admin/logout") {
    const token = getCookie(request, "admin_token");
    if (token) {
      await execute(env, "DELETE FROM admin_sessions WHERE token = ?", [token]);
    }
    const headers = new Headers();
    headers.append("Set-Cookie", "admin_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    headers.append("Location", "/admin");
    return new Response(null, { status: 302, headers });
  }

  // --- بررسی دسترسی برای سایر روت‌ها ---
  if (!(await isAdminAuthed(request, env))) {
    return redirect("/admin");
  }

  // --- مدیریت واژه‌ها (با صفحه‌بندی) ---
  if (url.pathname === "/admin/words") {
    const search = (url.searchParams.get("q") || "").trim();
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;
    
    const page = Math.min(rawPage, 1000000); 
    const limit = 50;
    const offset = (page - 1) * limit;

    const fromSql = "FROM words w";
    let whereSql = "WHERE 1 = 1";
    const baseParams: any[] = [];
    
    if (search) {
      whereSql += " AND (w.english LIKE ? OR w.persian LIKE ? OR w.lesson_name LIKE ?)";
      baseParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countRow = await queryOne<{ total: number }>(
      env, 
      `SELECT COUNT(*) as total ${fromSql} ${whereSql}`,
      baseParams
    );
    const totalCount = countRow?.total || 0;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const dataSql = `
      SELECT
        w.id,
        w.english,
        w.persian,
        w.level,
        w.lesson_name,
        w.is_active,
        CASE WHEN COUNT(wq.id) > 0 THEN 1 ELSE 0 END AS has_test
      ${fromSql}
      LEFT JOIN word_questions wq ON wq.word_id = w.id
      ${whereSql}
      GROUP BY w.id, w.english, w.persian, w.level, w.lesson_name, w.is_active
      ORDER BY w.id DESC
      LIMIT ? OFFSET ?
    `;
    const dataParams = [...baseParams, limit, offset];
    
    const words = await queryAll<any>(env, dataSql, dataParams);

    const rowsHtml = words.map((w: any) => `
      <tr>
        <td>${w.id}</td>
        <td>${escapeHtml(w.english)}</td>
        <td>${escapeHtml(w.persian)}</td>
        <td>${w.level}</td>
        <td>${w.lesson_name ? escapeHtml(w.lesson_name) : "-"}</td>
        <td style="text-align:center; font-size:15px;">${w.has_test ? "✅" : "⚪"}</td>
        <td><span class="${w.is_active ? "badge active" : "badge inactive"}">${w.is_active ? "فعال" : "غیرفعال"}</span></td>
        <td class="actions" style="display:flex; align-items:center; gap:5px;">
          <a href="/admin/words/edit?id=${w.id}">ویرایش</a>
          <a href="/admin/words/questions?word_id=${w.id}">سوالات</a>
          <form method="post" action="/admin/words/delete" onsubmit="return confirm('⚠️ اخطار: با حذف این واژه، تمام سوابق یادگیری کاربران، سوالات و آمارهای مربوط به آن برای همیشه پاک می‌شود. آیا مطمئن هستید؟');" style="margin:0;">
            <input type="hidden" name="id" value="${w.id}" />
            <button type="submit" class="danger" style="padding:2px 6px; font-size:11px;">حذف</button>
          </form>
        </td>
      </tr>
    `).join("");

    const paginationHtml = `
      <div style="margin-top: 16px; display: flex; gap: 6px; align-items: center; justify-content: center; direction: ltr; flex-wrap: wrap;">
        
        ${page > 2 ? `<a href="/admin/words?q=${escapeHtml(search)}&page=1"><button class="secondary" title="First Page">⏮ 1</button></a>` : ""}

        ${page > 1 ? `<a href="/admin/words?q=${escapeHtml(search)}&page=${page - 1}"><button class="secondary">Previous</button></a>` : ""}
        
        <form method="get" action="/admin/words" style="display:flex; align-items:center; gap:5px; margin:0;">
            <input type="hidden" name="q" value="${escapeHtml(search)}" />
            <span style="font-size: 13px;">Page</span>
            <input type="number" name="page" value="${page}" min="1" max="${totalPages}" style="width: 60px; text-align: center; padding: 4px; margin: 0; border: 1px solid #ccc; border-radius: 4px;" />
            <span style="font-size: 13px;">of ${totalPages}</span>
            <button type="submit" class="secondary" style="padding: 4px 8px; font-size: 12px; background: #2563eb; color: white; border: none;">Go</button>
        </form>

        ${page < totalPages ? `<a href="/admin/words?q=${escapeHtml(search)}&page=${page + 1}"><button class="secondary">Next</button></a>` : ""}
        
        ${page < totalPages - 1 ? `<a href="/admin/words?q=${escapeHtml(search)}&page=${totalPages}"><button class="secondary" title="Last Page">${totalPages} ⏭</button></a>` : ""}
      </div>
      <div style="text-align: center; margin-top: 5px; font-size: 11px; color: #666;">Total: ${totalCount} words</div>
    `;
    const content = `
      <div class="top-row">
        <form method="get" action="/admin/words" style="flex:1; display:flex; gap:8px;">
          <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:200px;" />
          <button type="submit" class="secondary">جستجو</button>
        </form>
        <div><a href="/admin/words/new"><button type="button">+ واژه‌ی جدید</button></a></div>
      </div>
      <table><thead><tr><th>ID</th><th>English</th><th>معنی فارسی</th><th>Level</th><th>درس</th><th>تست</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='8'>هیچ واژه‌ای پیدا نشد.</td></tr>"}</tbody></table>
      ${paginationHtml}
    `;
    return htmlResponse(renderAdminLayout("مدیریت واژه‌ها", content, "words"));
  }

  if (url.pathname === "/admin/words/questions") {
    const wordId = Number(url.searchParams.get("word_id"));
    if (!wordId) return htmlResponse("شناسه واژه نامعتبر است.", 400);
    const word = await queryOne<any>(env, "SELECT * FROM words WHERE id = ?", [wordId]);
    if (!word) return htmlResponse("واژه پیدا نشد.", 404);
    const questions = await queryAll<any>(env, "SELECT * FROM word_questions WHERE word_id = ? ORDER BY id DESC", [wordId]);

    const questionsHtml = questions.length === 0 ? "<p>هنوز سوالی برای این واژه ثبت نشده است.</p>" : questions.map((q: any) => `
      <div class="q-box">
        <div class="q-meta">ID: ${q.id} | Style: ${q.question_style} | Source: ${q.source}</div>
        <div class="q-text">${escapeHtml(q.question_text)}</div>
        <div>
          <span class="q-opt ${q.correct_option === 'A' ? 'q-correct' : ''}">A) ${escapeHtml(q.option_a)}</span>
          <span class="q-opt ${q.correct_option === 'B' ? 'q-correct' : ''}">B) ${escapeHtml(q.option_b)}</span>
          <span class="q-opt ${q.correct_option === 'C' ? 'q-correct' : ''}">C) ${escapeHtml(q.option_c)}</span>
          <span class="q-opt ${q.correct_option === 'D' ? 'q-correct' : ''}">D) ${escapeHtml(q.option_d)}</span>
        </div>
        <div style="margin-top:8px; border-top:1px dashed #ddd; padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; color:#555;">توضیح: ${escapeHtml(q.explanation_text || "-")}</span>
          <form method="post" action="/admin/words/questions/delete" onsubmit="return confirm('آیا مطمئنی؟');" style="margin:0;">
            <input type="hidden" name="id" value="${q.id}" />
            <input type="hidden" name="word_id" value="${wordId}" />
            <button type="submit" class="danger" style="padding:2px 8px; font-size:11px;">حذف</button>
          </form>
        </div>
      </div>
    `).join("");

    const content = `
      <div style="margin-bottom:12px;"><a href="/admin/words">← بازگشت به لیست واژه‌ها</a></div>
      <h2>سوالات واژه‌ی: <span style="color:#2563eb;">${escapeHtml(word.english)}</span> (${escapeHtml(word.persian)})</h2>
      ${questionsHtml}
    `;
    return htmlResponse(renderAdminLayout(`سوالات: ${word.english}`, content, "words"));
  }

  // === اصلاح شده: حذف امن سوال و وابستگی‌هایش ===
  if (request.method === "POST" && url.pathname === "/admin/words/questions/create") {
    const form = await parseForm(request);
    const wordId = Number(form.get("word_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();
    if (!wordId) return htmlResponse("شناسه واژه نامعتبر است.", 400);

    const word = await queryOne<{ id: number }>(env, "SELECT id FROM words WHERE id = ?", [wordId]);
    if (!word) return htmlResponse("واژه پیدا نشد.", 404);

    const validation = parseAndValidateQuestionForm(form);
    if (validation.error || !validation.data) {
      return htmlResponse(renderAdminLayout("خطا", `<div class=\"error\">${escapeHtml(validation.error || "داده نامعتبر است")}</div>`, "words"), 400);
    }

    const q = validation.data;
    await execute(
      env,
      `INSERT INTO word_questions (word_id, question_text, option_a, option_b, option_c, option_d, correct_option, question_style, explanation_text, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [wordId, q.questionText, q.optionA, q.optionB, q.optionC, q.optionD, q.correctOption, q.questionStyle, q.explanationText, q.source]
    );

    return redirect(getQuestionRedirectPath("word", wordId, returnTo));
  }

  

  if (request.method === "POST" && url.pathname === "/admin/words/questions/update") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const wordId = Number(form.get("word_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();
    if (!id || !wordId) return htmlResponse("شناسه سوال/واژه نامعتبر است.", 400);

    const question = await queryOne<{ id: number }>(env, "SELECT id FROM word_questions WHERE id = ? AND word_id = ?", [id, wordId]);
    if (!question) return htmlResponse("سوال پیدا نشد.", 404);

    const validation = parseAndValidateQuestionForm(form);
    if (validation.error || !validation.data) {
      return htmlResponse(renderAdminLayout("خطا", `<div class=\"error\">${escapeHtml(validation.error || "داده نامعتبر است")}</div>`, "words"), 400);
    }

    const q = validation.data;
    await execute(
      env,
      `UPDATE word_questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=?, question_style=?, explanation_text=?, source=? WHERE id=? AND word_id=?`,
      [q.questionText, q.optionA, q.optionB, q.optionC, q.optionD, q.correctOption, q.questionStyle, q.explanationText, q.source, id, wordId]
    );

    return redirect(getQuestionRedirectPath("word", wordId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/words/questions/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const wordId = Number(form.get("word_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();
    
    if (id) {
      // 1. حذف تاریخچه پاسخ‌های کاربران به این سوال (وابستگی اول)
      await execute(env, "DELETE FROM user_word_question_history WHERE question_id = ?", [id]);

      // 2. پیدا کردن و حذف سوالات مربوط در دوئل‌ها (وابستگی دوم)
      const duelQuestions = await queryAll<{ id: number }>(
        env, 
        "SELECT id FROM duel_questions WHERE word_question_id = ?", 
        [id]
      );
      
      if (duelQuestions.length > 0) {
        const dqIds = duelQuestions.map(q => q.id).join(",");
        // الف) حذف پاسخ‌های دوئل
        await execute(env, `DELETE FROM duel_answers WHERE duel_question_id IN (${dqIds})`);
        // ب) حذف خود سوالات دوئل
        await execute(env, `DELETE FROM duel_questions WHERE id IN (${dqIds})`);
      }

      // 3. حالا که وابستگی‌ها پاک شدند، خود سوال را حذف کن
      await execute(env, "DELETE FROM word_questions WHERE id = ?", [id]);
    }
    
    return redirect(getQuestionRedirectPath("word", wordId, returnTo));
  }

  // === هندلر جدید: ایمپورت JSON برای واژه‌ها ===
  if (request.method === "POST" && url.pathname === "/admin/words/questions/import_json") {
    const form = await parseForm(request);
    const wordId = Number(form.get("word_id"));
    const jsonData = (form.get("json_data") || "").toString().trim();
    const returnTo = (form.get("return_to") || "").toString().trim();

    if (!wordId) return htmlResponse("شناسه واژه نامعتبر است.", 400);

    let questionsArray: any[] = [];
    try {
      questionsArray = JSON.parse(jsonData);
    } catch (e) {
      return htmlResponse(renderAdminLayout("خطا", '<div class="error" style="color:red; padding:20px;">فرمت JSON اشتباه است. لطفا چک کنید ویرگول یا پرانتز کم و زیاد نباشد.</div>', "words"), 400);
    }

    if (!Array.isArray(questionsArray)) {
      return htmlResponse(renderAdminLayout("خطا", '<div class="error">ورودی باید یک لیست [] باشد.</div>', "words"), 400);
    }

    const validQuestions = [];
    for (const item of questionsArray) {
      if (item.questionText && Array.isArray(item.options) && item.options.length === 4 && typeof item.correctIndex === 'number') {
        validQuestions.push({
          wordId: wordId,
          questionText: item.questionText,
          options: item.options,
          correctIndex: item.correctIndex,
          explanation: item.explanation || "",
          questionStyle: item.questionStyle || "en_to_fa",
          source: "manual" as const
        });
      }
    }

    if (validQuestions.length > 0) {
      await insertWordQuestions(env, wordId, validQuestions);
    }

    return redirect(getQuestionRedirectPath("word", wordId, returnTo));
  }

  if (url.pathname === "/admin/words/new") {
    const word = { id: "", english: "", persian: "", level: 1, lesson_name: "", synonyms: "", antonyms: "", is_active: 1 };
    return htmlResponse(renderAdminLayout("ایجاد واژه جدید", renderWordForm(word, "ایجاد واژه جدید"), "words"));
  }

  if (url.pathname === "/admin/words/edit") {
    const id = Number(url.searchParams.get("id"));
    if (!id) return htmlResponse("شناسه واژه نامعتبر است.", 400);
    const word = await queryOne<any>(env, `SELECT * FROM words WHERE id = ?`, [id]);
    if (!word) return htmlResponse("واژه پیدا نشد.", 404);
    const prevWord = await queryOne<{ id: number }>(env, `SELECT id FROM words WHERE id > ? ORDER BY id ASC LIMIT 1`, [id]);
    const nextWord = await queryOne<{ id: number }>(env, `SELECT id FROM words WHERE id < ? ORDER BY id DESC LIMIT 1`, [id]);
    const navigation = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
        ${prevWord ? `<a href="/admin/words/edit?id=${prevWord.id}"><button type="button" class="secondary">واژه قبلی</button></a>` : ""}
        ${nextWord ? `<a href="/admin/words/edit?id=${nextWord.id}"><button type="button" class="secondary">واژه بعدی</button></a>` : ""}
      </div>
    `;
    const questions = await queryAll<any>(env, "SELECT * FROM word_questions WHERE word_id = ? ORDER BY id DESC", [id]);
    return htmlResponse(renderAdminLayout("ویرایش واژه", `${navigation}${renderWordForm(word, "ویرایش واژه", questions)}`, "words"));
  }

  if (request.method === "POST" && url.pathname === "/admin/words/save") {
    const form = await parseForm(request);
    const idStr = (form.get("id") || "").toString().trim();
    const english = (form.get("english") || "").toString().trim();
    const persian = (form.get("persian") || "").toString().trim();
    const level = Number(form.get("level") || 1);
    const lessonName = (form.get("lesson_name") || "").toString().trim() || null;
    const synonyms = (form.get("synonyms") || "").toString().trim() || null;
    const antonyms = (form.get("antonyms") || "").toString().trim() || null;
    const isActive = form.get("is_active") === "1" ? 1 : 0;

    if (!english || !persian) {
      return htmlResponse(renderAdminLayout("خطا", '<div class="error">فیلدهای English و معنی فارسی الزامی هستند.</div>', "words"), 400);
    }

    if (idStr) {
      await execute(env, `UPDATE words SET english=?, persian=?, level=?, lesson_name=?, synonyms=?, antonyms=?, is_active=?, updated_at=datetime('now') WHERE id=?`, [english, persian, level, lessonName, synonyms, antonyms, isActive, Number(idStr)]);
    } else {
      await execute(env, `INSERT INTO words (english, persian, level, lesson_name, synonyms, antonyms, order_index, is_active) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(order_index), 0) + 1 FROM words), ?)`, [english, persian, level, lessonName, synonyms, antonyms, isActive]);
    }
    return redirect("/admin/words");
  }

  // --- مدیریت متن‌ها ---
  if (url.pathname === "/admin/texts") {
    const search = (url.searchParams.get("q") || "").trim();
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;

    const page = Math.min(rawPage, 1000000);
    const limit = 50;
    const offset = (page - 1) * limit;

    const fromSql = "FROM reading_texts t";
    let whereSql = "WHERE 1 = 1";
    const baseParams: any[] = [];
    if (search) {
      whereSql += " AND (t.title LIKE ? OR t.body_en LIKE ?)";
      baseParams.push(`%${search}%`, `%${search}%`);
    }

    const countRow = await queryOne<{ total: number }>(env, `SELECT COUNT(*) as total ${fromSql} ${whereSql}`, baseParams);
    const totalCount = countRow?.total || 0;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const texts = await queryAll<any>(
      env,
      `
        SELECT
          t.id,
          t.title,
          substr(t.body_en, 1, 120) AS snippet,
          t.level,
          t.is_active,
          CASE WHEN COUNT(tq.id) > 0 THEN 1 ELSE 0 END AS has_test
        ${fromSql}
        LEFT JOIN text_questions tq ON tq.text_id = t.id
        ${whereSql}
        GROUP BY t.id, t.title, t.body_en, t.level, t.is_active
        ORDER BY t.id DESC
        LIMIT ? OFFSET ?
      `,
      [...baseParams, limit, offset]
    );
    const rowsHtml = texts.map((t: any) => `
      <tr>
        <td>${t.id}</td>
        <td>${escapeHtml(t.title)}</td>
        <td>${escapeHtml(t.snippet || "")}</td>
        <td>${t.level ?? "-"}</td>
        <td style="text-align:center; font-size:15px;">${t.has_test ? "✅" : "⚪"}</td>
        <td><span class="${t.is_active ? "badge active" : "badge inactive"}">${t.is_active ? "فعال" : "غیرفعال"}</span></td>
        <td class="actions" style="display:flex; align-items:center; gap:5px;">
          <a href="/admin/texts/edit?id=${t.id}">ویرایش</a>
          <form method="post" action="/admin/texts/delete" onsubmit="return confirm('⚠️ اخطار: با حذف این متن، تمام سوالات، سشن‌های مطالعه و سوابق مربوط به آن برای همیشه پاک می‌شود. آیا مطمئن هستید؟');" style="margin:0;">
            <input type="hidden" name="id" value="${t.id}" />
            <button type="submit" class="danger" style="padding:2px 6px; font-size:11px;">حذف</button>
          </form>
        </td>
      </tr>
    `).join("");
    const content = `
      <div class="top-row"><div></div><div><a href="/admin/texts/new"><button type="button">+ متن جدید</button></a></div></div>
      <form method="get" action="/admin/texts" class="top-row">
        <input type="text" name="q" value="${escapeHtml(search)}" placeholder="جستجو در عنوان/متن..." />
        <div style="display:flex; gap:8px; align-items:center;">
          <button type="submit">جستجو</button>
          ${search ? `<a href="/admin/texts"><button type="button" class="secondary">پاک کردن</button></a>` : ""}
        </div>
      </form>
      <table><thead><tr><th>ID</th><th>عنوان</th><th>پیش‌نمایش متن</th><th>Level</th><th>تست</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='7'>هیچ متنی ثبت نشده.</td></tr>"}</tbody></table>
      <div style="margin-top:12px; display:flex; justify-content:center; gap:12px; align-items:center;">
        ${page > 1 ? `<a href="/admin/texts?q=${escapeHtml(search)}&page=${page - 1}"><button class="secondary">Previous</button></a>` : ""}
        <span style="font-size: 13px; font-weight: bold;">Page ${page} of ${totalPages}</span>
        ${page < totalPages ? `<a href="/admin/texts?q=${escapeHtml(search)}&page=${page + 1}"><button class="secondary">Next</button></a>` : ""}
      </div>
    `;
    return htmlResponse(renderAdminLayout("مدیریت متن‌ها", content, "texts"));
  }

  if (url.pathname === "/admin/texts/new") {
    const text = { id: "", title: "", body_en: "", level: "", is_active: 1 };
    return htmlResponse(renderAdminLayout("ایجاد متن جدید", renderTextForm(text, "ایجاد متن جدید"), "texts"));
  }

  if (url.pathname === "/admin/texts/edit") {
    const id = Number(url.searchParams.get("id"));
    if (!id) return htmlResponse("شناسه متن نامعتبر است.", 400);
    const textRow = await queryOne<any>(env, `SELECT * FROM reading_texts WHERE id = ?`, [id]);
    if (!textRow) return htmlResponse("متن پیدا نشد.", 404);
    const prevText = await queryOne<{ id: number }>(env, `SELECT id FROM reading_texts WHERE id > ? ORDER BY id ASC LIMIT 1`, [id]);
    const nextText = await queryOne<{ id: number }>(env, `SELECT id FROM reading_texts WHERE id < ? ORDER BY id DESC LIMIT 1`, [id]);
    const navigation = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
        ${prevText ? `<a href="/admin/texts/edit?id=${prevText.id}"><button type="button" class="secondary">متن قبلی</button></a>` : ""}
        ${nextText ? `<a href="/admin/texts/edit?id=${nextText.id}"><button type="button" class="secondary">متن بعدی</button></a>` : ""}
      </div>
    `;
    const questions = await queryAll<any>(env, "SELECT id, text_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, source, COALESCE(question_type, 'reading') AS question_type FROM text_questions WHERE text_id = ? ORDER BY id DESC", [id]);
    return htmlResponse(renderAdminLayout("ویرایش متن", `${navigation}${renderTextForm(textRow, "ویرایش متن", questions)}`, "texts"));
  }


  if (url.pathname === "/admin/texts/questions") {
    const textId = Number(url.searchParams.get("text_id"));
    if (!textId) return htmlResponse("شناسه متن نامعتبر است.", 400);
    const text = await queryOne<any>(env, "SELECT * FROM reading_texts WHERE id = ?", [textId]);
    if (!text) return htmlResponse("متن پیدا نشد.", 404);
    const questions = await queryAll<any>(env, "SELECT *, COALESCE(question_type, 'reading') AS question_type FROM text_questions WHERE text_id = ? ORDER BY id DESC", [textId]);

    const questionsHtml = questions.length === 0 ? "<p>هنوز سوالی برای این متن ثبت نشده است.</p>" : questions.map((q: any) => `
      <div class="q-box">
        <div class="q-meta">ID: ${q.id} | Type: ${escapeHtml(q.question_type || "reading")} | Source: ${q.source}</div>
        <div class="q-text">${escapeHtml(q.question_text)}</div>
        <div>
          <span class="q-opt ${q.correct_option === 'A' ? 'q-correct' : ''}">A) ${escapeHtml(q.option_a)}</span>
          <span class="q-opt ${q.correct_option === 'B' ? 'q-correct' : ''}">B) ${escapeHtml(q.option_b)}</span>
          <span class="q-opt ${q.correct_option === 'C' ? 'q-correct' : ''}">C) ${escapeHtml(q.option_c)}</span>
          <span class="q-opt ${q.correct_option === 'D' ? 'q-correct' : ''}">D) ${escapeHtml(q.option_d)}</span>
        </div>
        <div style="margin-top:8px; border-top:1px dashed #ddd; padding-top:6px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; color:#555;">توضیح: ${escapeHtml(q.explanation_text || "-")}</span>
          <form method="post" action="/admin/texts/questions/delete" onsubmit="return confirm('آیا مطمئنی؟');" style="margin:0;">
            <input type="hidden" name="id" value="${q.id}" />
            <input type="hidden" name="text_id" value="${textId}" />
            <button type="submit" class="danger" style="padding:2px 8px; font-size:11px;">حذف</button>
          </form>
        </div>
      </div>
    `).join("");

    const content = `
      <div style="margin-bottom:12px;"><a href="/admin/texts">← بازگشت به لیست متن‌ها</a></div>
      <h2>سوالات متن: <span style="color:#2563eb;">${escapeHtml(text.title)}</span></h2>
      ${questionsHtml}
    `;
    return htmlResponse(renderAdminLayout(`سوالات متن: ${text.title}`, content, "texts"));
  }

  if (request.method === "POST" && url.pathname === "/admin/texts/questions/create") {
    const form = await parseForm(request);
    const textId = Number(form.get("text_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();
    if (!textId) return htmlResponse("شناسه متن نامعتبر است.", 400);

    const text = await queryOne<{ id: number }>(env, "SELECT id FROM reading_texts WHERE id = ?", [textId]);
    if (!text) return htmlResponse("متن پیدا نشد.", 404);

    const validation = parseAndValidateQuestionForm(form);
    if (validation.error || !validation.data) {
      return htmlResponse(renderAdminLayout("خطا", `<div class=\"error\">${escapeHtml(validation.error || "داده نامعتبر است")}</div>`, "texts"), 400);
    }

    const q = validation.data;
    await execute(
      env,
      `INSERT INTO text_questions (text_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, question_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [textId, q.questionText, q.optionA, q.optionB, q.optionC, q.optionD, q.correctOption, q.explanationText, q.questionStyle, q.source]
    );

    return redirect(getQuestionRedirectPath("text", textId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/texts/questions/update") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const textId = Number(form.get("text_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();
    if (!id || !textId) return htmlResponse("شناسه سوال/متن نامعتبر است.", 400);

    const question = await queryOne<{ id: number }>(env, "SELECT id FROM text_questions WHERE id = ? AND text_id = ?", [id, textId]);
    if (!question) return htmlResponse("سوال پیدا نشد.", 404);

    const validation = parseAndValidateQuestionForm(form);
    if (validation.error || !validation.data) {
      return htmlResponse(renderAdminLayout("خطا", `<div class=\"error\">${escapeHtml(validation.error || "داده نامعتبر است")}</div>`, "texts"), 400);
    }

    const q = validation.data;
    await execute(
      env,
      `UPDATE text_questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=?, explanation_text=?, question_type=?, source=? WHERE id=? AND text_id=?`,
      [q.questionText, q.optionA, q.optionB, q.optionC, q.optionD, q.correctOption, q.explanationText, q.questionStyle, q.source, id, textId]
    );

    return redirect(getQuestionRedirectPath("text", textId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/texts/questions/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const textId = Number(form.get("text_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();

    if (id) {
      await execute(env, "DELETE FROM user_text_question_history WHERE question_id = ?", [id]);
      await execute(env, "DELETE FROM text_questions WHERE id = ? AND text_id = ?", [id, textId]);
    }

    return redirect(getQuestionRedirectPath("text", textId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/texts/save") {
    const form = await parseForm(request);
    const idStr = (form.get("id") || "").toString().trim();
    const title = (form.get("title") || "").toString().trim();
    const bodyEn = (form.get("body_en") || "").toString().trim();
    const level = form.get("level") ? Number(form.get("level")) : null;
    const isActive = form.get("is_active") === "1" ? 1 : 0;

    if (!title || !bodyEn) {
       return htmlResponse(renderAdminLayout("خطا", '<div class="error">عنوان و متن الزامی است</div>', "texts"), 400);
    }

    if (idStr) {
      await execute(env, `UPDATE reading_texts SET title=?, body_en=?, level=?, is_active=?, updated_at=datetime('now') WHERE id=?`, [title, bodyEn, level, isActive, Number(idStr)]);
    } else {
      await execute(env, `INSERT INTO reading_texts (title, body_en, level, is_active) VALUES (?, ?, ?, ?)`, [title, bodyEn, level, isActive]);
    }
    return redirect("/admin/texts");
  }

  // === حذف امن متن و تمام وابستگی‌هایش ===
  if (request.method === "POST" && url.pathname === "/admin/texts/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));

    if (id) {
      // ۱. حذف تاریخچه پاسخ‌های کاربران به سوالات این متن
      await execute(env, `DELETE FROM user_text_question_history WHERE question_id IN (SELECT id FROM text_questions WHERE text_id = ?)`, [id]);

      // ۲. حذف سوالات این متن
      await execute(env, `DELETE FROM text_questions WHERE text_id = ?`, [id]);

      // ۳. حذف سشن‌های مطالعه مرتبط
      await execute(env, `DELETE FROM reading_sessions WHERE text_id = ?`, [id]);

      // ۴. حذف خود متن
      await execute(env, `DELETE FROM reading_texts WHERE id = ?`, [id]);
    }

    return redirect("/admin/texts");
  }

  // --- مدیریت کاربران (با صفحه‌بندی) ---
  if (url.pathname === "/admin/users") {
    const search = (url.searchParams.get("q") || "").trim();
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;
    const page = Math.min(rawPage, 1000000);    
    const limit = 50; 
    const offset = (page - 1) * limit;

    let whereSql = "FROM users u LEFT JOIN access_codes ac ON ac.used_by_user_id = u.id WHERE 1 = 1";
    const baseParams: any[] = [];

    if (search) {
      whereSql += ` AND (u.display_name LIKE ? OR u.username LIKE ? OR cast(u.telegram_id as text) LIKE ?)`;
      baseParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countRow = await queryOne<{ total: number }>(
      env,
      `SELECT COUNT(*) as total ${whereSql}`,
      baseParams
    );
    const totalCount = countRow?.total || 0;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const dataSql = `SELECT u.id, u.telegram_id, u.username, u.display_name, u.xp_total, u.created_at, u.is_approved, ac.code as license_code ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`;
    const dataParams = [...baseParams, limit, offset];

    const users = await queryAll<any>(env, dataSql, dataParams);

    const rowsHtml = users.map((u: any) => `
      <tr>
        <td>${u.id}</td>
        <td>${u.telegram_id}</td>
        <td>${u.username ? escapeHtml(u.username) : "-"}</td>
        <td>${escapeHtml(u.display_name || "")}</td>
        <td><b>${u.xp_total}</b></td>
        <td>${u.created_at.substring(0, 10)}</td>
        <td>${u.license_code ? `<span style="font-family:monospace; background:#eee; padding:2px 4px;">${escapeHtml(u.license_code)}</span>` : (u.is_approved ? '<span class="badge active">دستی</span>' : '<span class="badge inactive">تایید نشده</span>')}</td>
        <td class="actions"><a href="/admin/users/edit?id=${u.id}">ویرایش</a></td>
      </tr>
    `).join("");

    const paginationHtml = `
      <div style="margin-top: 16px; display: flex; gap: 10px; align-items: center; justify-content: center; direction: ltr;">
        ${page > 1 ? `<a href="/admin/users?q=${escapeHtml(search)}&page=${page - 1}"><button class="secondary">Previous</button></a>` : ""}
        <span style="font-size: 13px; font-weight: bold;">Page ${page} of ${totalPages}</span>
        ${page < totalPages ? `<a href="/admin/users?q=${escapeHtml(search)}&page=${page + 1}"><button class="secondary">Next</button></a>` : ""}
      </div>
      <div style="text-align: center; margin-top: 5px; font-size: 11px; color: #666;">Total: ${totalCount} users</div>
    `;

    const content = `
      <div class="top-row">
        <form method="get" action="/admin/users" style="flex:1; display:flex; gap:8px;">
          <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:250px;" />
          <button type="submit" class="secondary">جستجو</button>
        </form>
      </div>
      <table><thead><tr><th>ID</th><th>Telegram</th><th>Username</th><th>نام</th><th>XP</th><th>عضویت</th><th>لایسنس</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='8'>یافت نشد.</td></tr>"}</tbody></table>
      ${paginationHtml}
    `;
    return htmlResponse(renderAdminLayout("مدیریت کاربران", content, "users"));
  }

  if (url.pathname === "/admin/users/edit") {
    const id = Number(url.searchParams.get("id"));
    if (!id) return htmlResponse("شناسه نامعتبر", 400);
    const userRow = await queryOne<any>(env, `SELECT * FROM users WHERE id = ?`, [id]);
    if (!userRow) return htmlResponse("کاربر پیدا نشد", 404);
    return htmlResponse(renderAdminLayout("ویرایش کاربر", renderUserForm(userRow, "ویرایش کاربر"), "users"));
  }

  if (request.method === "POST" && url.pathname === "/admin/users/save") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const displayName = (form.get("display_name") || "").toString().trim();
    const xpTotal = Number(form.get("xp_total") || 0);
    const isApproved = form.get("is_approved") === "1" ? 1 : 0;

    if (id) {
      await execute(env, `UPDATE users SET display_name=?, xp_total=?, is_approved=?, updated_at=datetime('now') WHERE id=?`, [displayName, xpTotal, isApproved, id]);
    }
    return redirect("/admin/users");
  }

  // --- لایسنس‌ها ---
  if (url.pathname === "/admin/licenses") {
    const codes = await queryAll<any>(env, `SELECT a.code, a.created_at, a.used_at, u.display_name, u.telegram_id FROM access_codes a LEFT JOIN users u ON u.id = a.used_by_user_id ORDER BY a.created_at DESC LIMIT 100`);
    const rows = codes.map((c) => `
      <tr>
        <td style="font-family:monospace;">${escapeHtml(c.code)}</td>
        <td>${c.used_at ? `<span class="badge inactive">استفاده شده: ${escapeHtml(c.display_name || c.telegram_id)}</span>` : `<span class="badge active">آزاد</span>`}</td>
        <td>${c.created_at.substring(0, 10)}</td>
      </tr>
    `).join("");

    const content = `
      <div class="top-row">
        <h3>مدیریت لایسنس‌ها</h3>
        <form method="post" action="/admin/licenses/create" style="display:flex; gap:8px;">
          <input type="text" name="new_code" placeholder="کد جدید..." required style="margin:0;" />
          <button type="submit">افزودن</button>
        </form>
      </div>
      <table><thead><tr><th>کد</th><th>وضعیت</th><th>تاریخ</th></tr></thead><tbody>${rows || "<tr><td colspan='3'>خالی.</td></tr>"}</tbody></table>
    `;
    return htmlResponse(renderAdminLayout("لایسنس‌ها", content, "licenses"));
  }

  if (request.method === "POST" && url.pathname === "/admin/licenses/create") {
    const form = await parseForm(request);
    const newCode = (form.get("new_code") || "").toString().trim();
    if (newCode) {
      try { await execute(env, `INSERT INTO access_codes (code) VALUES (?)`, [newCode]); } catch {}
    }
    return redirect("/admin/licenses");
  }
// === شروع کد جدید: حذف امن واژه ===
  if (request.method === "POST" && url.pathname === "/admin/words/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));

    if (id) {
      // ترتیب حذف بسیار مهم است تا دیتابیس ارور ندهد:
      
      // ۱. حذف پاسخ‌های مربوط به این واژه در دوئل‌ها
      await execute(env, `DELETE FROM duel_answers WHERE duel_question_id IN (SELECT id FROM duel_questions WHERE word_id = ?)`, [id]);

      // ۲. حذف سوالات این واژه از جدول دوئل‌ها
      await execute(env, `DELETE FROM duel_questions WHERE word_id = ?`, [id]);

      // ۳. حذف تاریخچه پاسخ‌های کاربران به سوالات این واژه (در لایتنر)
      await execute(env, `DELETE FROM user_word_question_history WHERE word_id = ?`, [id]);

      // ۴. حذف وضعیت لایتنر (SM2) مربوط به این واژه برای همه کاربران
      await execute(env, `DELETE FROM user_words_sm2 WHERE word_id = ?`, [id]);

      // ۵. حذف خود سوالات طراحی شده برای این واژه
      await execute(env, `DELETE FROM word_questions WHERE word_id = ?`, [id]);

      // ۶. و در نهایت حذف خود واژه از جدول اصلی
      await execute(env, `DELETE FROM words WHERE id = ?`, [id]);
    }
    
    // بازگشت به صفحه لیست واژه‌ها
    return redirect("/admin/words");
  }
  // === پایان کد جدید ===

  // --- تغییر وضعیت AI (start/stop) ---
  if (request.method === "POST" && url.pathname === "/admin/ai-logs/toggle") {
    const currentRow = await queryOne<{ value: string }>(env, "SELECT value FROM system_settings WHERE key = 'ai_generation_enabled'");
    const current = currentRow?.value === "1";
    const newValue = current ? "0" : "1";
    await execute(env, `INSERT INTO system_settings (key, value, updated_at) VALUES ('ai_generation_enabled', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`, [newValue, newValue]);
    // اگر ادمین شروع مجدد زد، circuit breaker را ریست کن
    if (!current) {
      await execute(env, `UPDATE ai_generation_log SET updated_at = datetime('now', '-31 minutes') WHERE status = 'error'`);
    }
    return redirect("/admin/ai-logs");
  }

  // --- ریست کردن خطاها (حذف رکوردهای error برای retry) ---
  if (request.method === "POST" && url.pathname === "/admin/ai-logs/reset-errors") {
    await execute(env, "DELETE FROM ai_generation_log WHERE status = 'error'");
    return redirect("/admin/ai-logs");
  }

  // --- لاگ تولید سوالات با AI ---
  if (url.pathname === "/admin/ai-logs") {
    const statusFilter = (url.searchParams.get("status") || "").trim();
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;
    const page = Math.min(rawPage, 1000000);
    const limit = 50;
    const offset = (page - 1) * limit;

    // وضعیت فعال/غیرفعال
    const settingRow = await queryOne<{ value: string }>(env, "SELECT value FROM system_settings WHERE key = 'ai_generation_enabled'");
    const isEnabled = settingRow?.value !== "0";

    // آمار کلی
    const stats = await queryOne<{ total: number; success: number; error: number; pending: number }>(
      env,
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM ai_generation_log`
    );

    // تعداد واژگان باقی‌مانده
    const remaining = await queryOne<{ count: number }>(
      env,
      `SELECT COUNT(*) as count FROM words w LEFT JOIN word_questions wq ON wq.word_id = w.id WHERE w.is_active = 1 AND wq.id IS NULL`
    );

    let whereSql = "WHERE 1 = 1";
    const params: any[] = [];
    if (statusFilter) {
      whereSql += " AND status = ?";
      params.push(statusFilter);
    }

    const countRow = await queryOne<{ total: number }>(env, `SELECT COUNT(*) as total FROM ai_generation_log ${whereSql}`, params);
    const totalCount = countRow?.total || 0;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const logs = await queryAll<any>(
      env,
      `SELECT 
        agl.id, agl.word_id, agl.word_english, agl.status,
        agl.generated_count, agl.error_message,
        agl.input_tokens, agl.output_tokens,
        agl.created_at, agl.updated_at
      FROM ai_generation_log agl
      ${whereSql}
      ORDER BY agl.id DESC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const statusBadge = (status: string) => {
      if (status === "success") return `<span class="badge active">✅ موفق</span>`;
      if (status === "error") return `<span class="badge inactive">❌ خطا</span>`;
      return `<span class="badge" style="background:#fef3c7;color:#92400e">⏳ در صف</span>`;
    };

    const rowsHtml = logs.map((log: any) => {
      const errFull = log.error_message ? escapeHtml(log.error_message) : "";
      const errShort = log.error_message ? escapeHtml(log.error_message.substring(0, 80)) : "-";
      const hasExpand = log.error_message && log.error_message.length > 80;
      return `
      <tr>
        <td style="font-size:11px;color:#999;">${log.id}</td>
        <td><a href="/admin/words/edit?id=${log.word_id}" style="font-weight:600;">${escapeHtml(log.word_english)}</a></td>
        <td>${statusBadge(log.status)}</td>
        <td style="text-align:center;">${log.generated_count || 0}</td>
        <td style="font-size:11px;color:#666;">${log.input_tokens ?? "-"} / ${log.output_tokens ?? "-"}</td>
        <td style="font-size:11px; max-width:300px;">
          ${log.status === "error" ? `
            <span style="color:#dc2626;">${errShort}</span>
            ${hasExpand ? `<details style="margin-top:4px;"><summary style="cursor:pointer;font-size:10px;color:#999;">نمایش کامل</summary><pre style="font-size:10px;white-space:pre-wrap;color:#dc2626;background:#fff5f5;padding:6px;border-radius:4px;margin-top:4px;">${errFull}</pre></details>` : ""}
          ` : "-"}
        </td>
        <td style="font-size:11px;color:#666;">${(log.updated_at || log.created_at).substring(0, 16).replace("T", " ")}</td>
      </tr>`;
    }).join("");

    const statsHtml = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-bottom:20px;">
        <div style="background:#f8fafc; border:1px solid #e2e8f0; padding:14px; border-radius:10px; text-align:center;">
          <div style="font-size:11px; color:#64748b; margin-bottom:4px;">واژه باقی‌مانده</div>
          <div style="font-size:26px; font-weight:700; color:#0f172a;">${remaining?.count ?? "?"}</div>
        </div>
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; padding:14px; border-radius:10px; text-align:center;">
          <div style="font-size:11px; color:#166534; margin-bottom:4px;">موفق</div>
          <div style="font-size:26px; font-weight:700; color:#166534;">${stats?.success || 0}</div>
        </div>
        <div style="background:#fff7ed; border:1px solid #fed7aa; padding:14px; border-radius:10px; text-align:center;">
          <div style="font-size:11px; color:#9a3412; margin-bottom:4px;">کل پردازش‌شده</div>
          <div style="font-size:26px; font-weight:700; color:#9a3412;">${stats?.total || 0}</div>
        </div>
        <div style="background:#fef2f2; border:1px solid #fecaca; padding:14px; border-radius:10px; text-align:center;">
          <div style="font-size:11px; color:#dc2626; margin-bottom:4px;">خطا</div>
          <div style="font-size:26px; font-weight:700; color:#dc2626;">${stats?.error || 0}</div>
        </div>
      </div>`;

    const controlHtml = `
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:16px; background:${isEnabled ? "#f0fdf4" : "#fef2f2"}; border:1px solid ${isEnabled ? "#bbf7d0" : "#fecaca"}; border-radius:10px; margin-bottom:20px;">
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:700; font-size:14px; color:${isEnabled ? "#166534" : "#dc2626"};">
            ${isEnabled ? "🟢 تولید خودکار فعال است" : "🔴 تولید خودکار متوقف شده"}
          </div>
          <div style="font-size:12px; color:#666; margin-top:3px;">
            ${isEnabled ? "هر دقیقه تا ۱۰ واژه پردازش می‌شود" : "Cron اجرا می‌شود ولی هیچ واژه‌ای پردازش نمی‌شود"}
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <form method="post" action="/admin/ai-logs/toggle" style="margin:0;">
            <button type="submit" style="background:${isEnabled ? "#dc2626" : "#059669"}; color:white; padding:8px 16px; border-radius:6px; border:none; cursor:pointer; font-size:13px; font-weight:600;">
              ${isEnabled ? "⏹ متوقف کردن" : "▶️ شروع مجدد"}
            </button>
          </form>
          ${(stats?.error || 0) > 0 ? `
          <form method="post" action="/admin/ai-logs/reset-errors" onsubmit="return confirm('خطاها حذف می‌شوند و دوباره امتحان می‌شوند. مطمئنی؟');" style="margin:0;">
            <button type="submit" style="background:#f59e0b; color:white; padding:8px 16px; border-radius:6px; border:none; cursor:pointer; font-size:13px;">
              🔄 تلاش مجدد برای خطاها (${stats?.error || 0})
            </button>
          </form>` : ""}
        </div>
      </div>`;

    const filterHtml = `
      <form method="get" action="/admin/ai-logs" style="display:flex; gap:8px; margin-bottom:12px; align-items:center;">
        <select name="status" style="margin:0; width:auto; padding:5px 8px;">
          <option value="">همه وضعیت‌ها</option>
          <option value="success" ${statusFilter === "success" ? "selected" : ""}>✅ موفق</option>
          <option value="error" ${statusFilter === "error" ? "selected" : ""}>❌ خطا</option>
          <option value="pending" ${statusFilter === "pending" ? "selected" : ""}>⏳ در صف</option>
        </select>
        <button type="submit" class="secondary">فیلتر</button>
        ${statusFilter ? `<a href="/admin/ai-logs"><button type="button" class="secondary">همه</button></a>` : ""}
        <span style="font-size:12px; color:#666; margin-right:auto;">نمایش ${totalCount} رکورد</span>
      </form>`;

    const paginationHtml = totalPages <= 1 ? "" : `
      <div style="margin-top:16px; display:flex; gap:6px; align-items:center; justify-content:center; direction:ltr; flex-wrap:wrap;">
        ${page > 1 ? `<a href="/admin/ai-logs?status=${statusFilter}&page=${page-1}"><button class="secondary">‹ قبلی</button></a>` : ""}
        <span style="font-size:13px; padding:6px 12px;">صفحه ${page} از ${totalPages}</span>
        ${page < totalPages ? `<a href="/admin/ai-logs?status=${statusFilter}&page=${page+1}"><button class="secondary">بعدی ›</button></a>` : ""}
      </div>`;

    const content = `
      ${controlHtml}
      ${statsHtml}
      <h3 style="margin-bottom:10px;">📋 لاگ‌های تولید</h3>
      ${filterHtml}
      <div style="overflow-x:auto;">
      <table style="table-layout:auto;">
        <thead>
          <tr>
            <th style="width:40px;">#</th>
            <th>واژه</th>
            <th style="width:90px;">وضعیت</th>
            <th style="width:60px;">سوالات</th>
            <th style="width:90px;">توکن‌ها</th>
            <th>پیام خطا</th>
            <th style="width:120px;">زمان</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || "<tr><td colspan='7' style='text-align:center; padding:20px; color:#999;'>هیچ لاگی یافت نشد.</td></tr>"}</tbody>
      </table>
      </div>
      ${paginationHtml}
    `;
    return htmlResponse(renderAdminLayout("🤖 مدیریت تولید AI", content, "ai-logs"));
  }

  return htmlResponse("Not Found", 404);
}

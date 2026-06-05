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

  // --- Analytics Dashboard ---
  if (url.pathname === "/admin/analytics") {
    const { getAnalyticsSummary, getCurrentUserStats, getAnalyticsHistory } = await import("../db/analytics");
    
    const [analyticsSummary, currentUserStats, dailyHistory, weeklyHistory] = await Promise.all([
      getAnalyticsSummary(env),
      getCurrentUserStats(env),
      getAnalyticsHistory(env, 'daily', 30),
      getAnalyticsHistory(env, 'weekly', 12)
    ]);

    // Generate simple charts using CSS bars
    const generateChart = (data: any[], label: string, valueField: string) => {
      if (!data || data.length === 0) return '<p style="color:#999;">داده‌ای موجود نیست</p>';
      
      const maxValue = Math.max(...data.map(d => d[valueField] || 0));
      const chartBars = data.slice(0, 10).reverse().map(d => {
        const value = d[valueField] || 0;
        const percentage = maxValue > 0 ? (value / maxValue) * 100 : 0;
        return `
          <div style="display:flex; align-items:center; margin-bottom:4px;">
            <span style="width:60px; font-size:11px; text-align:left;">${d.date}</span>
            <div style="flex:1; margin:0 8px; background:#e5e7eb; border-radius:3px; height:16px; position:relative;">
              <div style="background:#2563eb; height:100%; border-radius:3px; width:${percentage}%;"></div>
            </div>
            <span style="width:30px; font-size:11px; text-align:right;">${value}</span>
          </div>
        `;
      }).join('');
      
      return `
        <div style="margin-top:16px;">
          <h4 style="margin-bottom:8px; font-size:14px;">${label}</h4>
          <div style="font-size:12px;">${chartBars}</div>
        </div>
      `;
    };

    const content = `
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:24px;">
        <div style="background:#f8fafc; padding:16px; border-radius:8px; border-left:4px solid #2563eb;">
          <div style="font-size:12px; color:#64748b; margin-bottom:4px;">کل کاربران</div>
          <div style="font-size:24px; font-weight:bold; color:#1e293b;">${currentUserStats.total_users}</div>
        </div>
        <div style="background:#f8fafc; padding:16px; border-radius:8px; border-left:4px solid #10b981;">
          <div style="font-size:12px; color:#64748b; margin-bottom:4px;">کاربران تایید شده</div>
          <div style="font-size:24px; font-weight:bold; color:#1e293b;">${currentUserStats.approved_users}</div>
        </div>
        <div style="background:#f8fafc; padding:16px; border-radius:8px; border-left:4px solid #f59e0b;">
          <div style="font-size:12px; color:#64748b; margin-bottom:4px;">فعال امروز</div>
          <div style="font-size:24px; font-weight:bold; color:#1e293b;">${currentUserStats.active_today}</div>
        </div>
        <div style="background:#f8fafc; padding:16px; border-radius:8px; border-left:4px solid #ef4444;">
          <div style="font-size:12px; color:#64748b; margin-bottom:4px;">مسدود شده</div>
          <div style="font-size:24px; font-weight:bold; color:#1e293b;">${currentUserStats.banned_users}</div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:16px; margin-bottom:24px;">
        <div style="background:#fef3c7; padding:16px; border-radius:8px;">
          <h3 style="margin-top:0; font-size:16px; color:#92400e;">📊 آمار روزانه</h3>
          ${analyticsSummary.daily ? `
            <div style="font-size:13px; line-height:1.6;">
              <div>کاربران فعال: <strong>${analyticsSummary.daily.active_users}</strong></div>
              <div>کاربران جدید: <strong>${analyticsSummary.daily.new_users}</strong></div>
              <div>کلمات یادگرفته شده: <strong>${analyticsSummary.daily.total_words_learned}</strong></div>
              <div>جلسات مطالعه: <strong>${analyticsSummary.daily.total_sessions}</strong></div>
              <div>میانگین زمان جلسه: <strong>${Math.round(analyticsSummary.daily.avg_session_duration)} دقیقه</strong></div>
            </div>
          ` : '<p style="color:#999;">داده‌ای برای امروز موجود نیست</p>'}
        </div>

        <div style="background:#dbeafe; padding:16px; border-radius:8px;">
          <h3 style="margin-top:0; font-size:16px; color:#1e40af;">📈 آمار هفتگی</h3>
          ${analyticsSummary.weekly ? `
            <div style="font-size:13px; line-height:1.6;">
              <div>کاربران فعال: <strong>${analyticsSummary.weekly.active_users}</strong></div>
              <div>کاربران جدید: <strong>${analyticsSummary.weekly.new_users}</strong></div>
              <div>کلمات یادگرفته شده: <strong>${analyticsSummary.weekly.total_words_learned}</strong></div>
              <div>جلسات مطالعه: <strong>${analyticsSummary.weekly.total_sessions}</strong></div>
              <div>میانگین زمان جلسه: <strong>${Math.round(analyticsSummary.weekly.avg_session_duration)} دقیقه</strong></div>
            </div>
          ` : '<p style="color:#999;">داده‌ای برای این هفته موجود نیست</p>'}
        </div>

        <div style="background:#dcfce7; padding:16px; border-radius:8px;">
          <h3 style="margin-top:0; font-size:16px; color:#166534;">📅 آمار ماهانه</h3>
          ${analyticsSummary.monthly ? `
            <div style="font-size:13px; line-height:1.6;">
              <div>کاربران فعال: <strong>${analyticsSummary.monthly.active_users}</strong></div>
              <div>کاربران جدید: <strong>${analyticsSummary.monthly.new_users}</strong></div>
              <div>کلمات یادگرفته شده: <strong>${analyticsSummary.monthly.total_words_learned}</strong></div>
              <div>جلسات مطالعه: <strong>${analyticsSummary.monthly.total_sessions}</strong></div>
              <div>میانگین زمان جلسه: <strong>${Math.round(analyticsSummary.monthly.avg_session_duration)} دقیقه</strong></div>
            </div>
          ` : '<p style="color:#999;">داده‌ای برای این ماه موجود نیست</p>'}
        </div>

        <div style="background:#fce7f3; padding:16px; border-radius:8px;">
          <h3 style="margin-top:0; font-size:16px; color:#9f1239;">📊 آمار سالانه</h3>
          ${analyticsSummary.yearly ? `
            <div style="font-size:13px; line-height:1.6;">
              <div>کاربران فعال: <strong>${analyticsSummary.yearly.active_users}</strong></div>
              <div>کاربران جدید: <strong>${analyticsSummary.yearly.new_users}</strong></div>
              <div>کلمات یادگرفته شده: <strong>${analyticsSummary.yearly.total_words_learned}</strong></div>
              <div>جلسات مطالعه: <strong>${analyticsSummary.yearly.total_sessions}</strong></div>
              <div>میانگین زمان جلسه: <strong>${Math.round(analyticsSummary.yearly.avg_session_duration)} دقیقه</strong></div>
            </div>
          ` : '<p style="color:#999;">داده‌ای برای امسال موجود نیست</p>'}
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:24px;">
        ${generateChart(dailyHistory, 'کاربران فعال روزانه (۳۰ روز گذشته)', 'active_users')}
        ${generateChart(weeklyHistory, 'کاربران فعال هفتگی (۱۲ هفته گذشته)', 'active_users')}
      </div>

      <div style="margin-top:24px; padding:16px; background:#f1f5f9; border-radius:8px;">
        <h4 style="margin-top:0; font-size:14px; color:#475569;">📝 نکات</h4>
        <ul style="font-size:12px; color:#64748b; margin:8px 0; padding-right:20px;">
          <li>آمارها هر روز ساعت ۲:۰۰ بامداد به طور خودکار محاسبه می‌شوند</li>
          <li>کاربران فعال: کاربرانی که در دوره زمانی مشخص فعالیتی داشته‌اند</li>
          <li>داده‌های قدیمی‌تر از ۲ سال به طور خودکار حذف می‌شوند</li>
          <li>برای بهینه‌سازی عملکرد، از داده‌های فشرده استفاده می‌شود</li>
        </ul>
      </div>
    `;

    return htmlResponse(renderAdminLayout("📊 داشبورد آمار", content, "analytics"));
  }

  return htmlResponse("Not Found", 404);
}

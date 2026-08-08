import { Env } from "../../types";
import { queryAll, queryOne, execute } from "../../db/client";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../../utils/response";
import { renderAdminLayout, renderWordForm } from "../views";
import { insertWordQuestions } from "../../db/word_questions";
import { parseAndValidateQuestionForm, getQuestionRedirectPath } from "../utils";
import { streamWordsExport } from "../word-export";
import { ADMIN_LIST_PAGE_SIZE } from "../../config/constants";

interface WordListRow {
  id: number;
  english: string;
  persian: string;
  level: number;
  lesson_name: string | null;
  is_active: number;
  has_test: number;
}

interface WordRow {
  id: number;
  english: string;
  persian: string;
  level: number;
  lesson_name: string | null;
  synonyms: string | null;
  antonyms: string | null;
  is_active: number;
}

interface WordQuestionRow {
  id: number;
  word_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  question_style: string;
  explanation_text: string | null;
  source: string;
}

/**
 * Handle admin routes for word CRUD and word question management.
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not a word route
 */
export async function handleWordRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  // Download the vocabulary as a JSON file. `q` (optional) narrows the export to
  // the same rows the list view shows for that search; `questions=1` nests each
  // word's test questions.
  if (url.pathname === "/admin/words/export") {
    return streamWordsExport(env, {
      search: (url.searchParams.get("q") || "").trim(),
      includeQuestions: url.searchParams.get("questions") === "1"
    });
  }

  if (url.pathname === "/admin/words") {
    const search = (url.searchParams.get("q") || "").trim();
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;
    const page = Math.min(rawPage, 1000000); 
    const limit = ADMIN_LIST_PAGE_SIZE;
    const offset = (page - 1) * limit;
    const fromSql = "FROM words w";
    let whereSql = "WHERE 1 = 1";
    const baseParams: unknown[] = [];
    if (search) {
      whereSql += " AND (w.english LIKE ? OR w.persian LIKE ? OR w.lesson_name LIKE ?)";
      baseParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countRow = await queryOne<{ total: number }>(env, `SELECT COUNT(*) as total ${fromSql} ${whereSql}`, baseParams);
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
    const words = await queryAll<WordListRow>(env, dataSql, dataParams);
    const rowsHtml = words.map((w) => `
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
    // Export box: a plain GET form, so the browser downloads the file directly.
    // When a search is active its checkbox is pre-checked (export what you see);
    // unchecking it drops the `q` param and exports the whole vocabulary.
    const exportHtml = `
      <form method="get" action="/admin/words/export" style="margin:12px 0 0; padding:10px 12px; border:1px solid #e0e0e0; border-radius:8px; background:#fafafa; display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <strong style="font-size:13px;">⬇️ خروجی JSON</strong>
        <label style="font-size:12px; display:flex; align-items:center; gap:5px; margin:0;">
          <input type="checkbox" name="questions" value="1" style="width:auto; margin:0;" />
          همراه با سوالات تست
        </label>
        ${search ? `
        <label style="font-size:12px; display:flex; align-items:center; gap:5px; margin:0;">
          <input type="checkbox" name="q" value="${escapeHtml(search)}" checked style="width:auto; margin:0;" />
          فقط نتایج جستجوی «${escapeHtml(search)}»
        </label>` : ""}
        <button type="submit">دانلود فایل</button>
        <span style="font-size:11px; color:#666;">${search ? "" : "همه‌ی واژه‌های دیتابیس در یک فایل JSON."}</span>
      </form>
    `;

    const content = `
      <div class="top-row">
        <form method="get" action="/admin/words" style="flex:1; display:flex; gap:8px;">
          <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:200px;" />
          <button type="submit" class="secondary">جستجو</button>
        </form>
        <div><a href="/admin/words/new"><button type="button">+ واژه‌ی جدید</button></a></div>
      </div>
      ${exportHtml}
      <table><thead><tr><th>ID</th><th>English</th><th>معنی فارسی</th><th>Level</th><th>درس</th><th>تست</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='8'>هیچ واژه‌ای پیدا نشد.</td></tr>"}</tbody></table>
      ${paginationHtml}
    `;
    return htmlResponse(renderAdminLayout("مدیریت واژه‌ها", content, "words"));
  }

  if (url.pathname === "/admin/words/questions") {
    const wordId = Number(url.searchParams.get("word_id"));
    if (!wordId) return htmlResponse("شناسه واژه نامعتبر است.", 400);
    const word = await queryOne<WordRow>(env, "SELECT * FROM words WHERE id = ?", [wordId]);
    if (!word) return htmlResponse("واژه پیدا نشد.", 404);
    const questions = await queryAll<WordQuestionRow>(env, "SELECT * FROM word_questions WHERE word_id = ? ORDER BY id DESC", [wordId]);

    const questionsHtml = questions.length === 0 ? "<p>هنوز سوالی برای این واژه ثبت نشده است.</p>" : questions.map((q) => `
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

    const questionData = validation.data;
    await execute(
      env,
      `INSERT INTO word_questions (word_id, question_text, option_a, option_b, option_c, option_d, correct_option, question_style, explanation_text, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [wordId, questionData.questionText, questionData.optionA, questionData.optionB, questionData.optionC, questionData.optionD, questionData.correctOption, questionData.questionStyle, questionData.explanationText, questionData.source]
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

    const questionData = validation.data;
    await execute(
      env,
      `UPDATE word_questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=?, question_style=?, explanation_text=?, source=? WHERE id=? AND word_id=?`,
      [questionData.questionText, questionData.optionA, questionData.optionB, questionData.optionC, questionData.optionD, questionData.correctOption, questionData.questionStyle, questionData.explanationText, questionData.source, id, wordId]
    );

    return redirect(getQuestionRedirectPath("word", wordId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/words/questions/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const wordId = Number(form.get("word_id"));
    const returnTo = (form.get("return_to") || "").toString().trim();
    
    if (id) {
      await execute(env, "DELETE FROM word_question_reports WHERE question_id = ?", [id]);
      await execute(env, "DELETE FROM user_word_question_history WHERE question_id = ?", [id]);
      await execute(env, "DELETE FROM word_questions WHERE id = ?", [id]);
    }

    return redirect(getQuestionRedirectPath("word", wordId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/words/questions/import_json") {
    const form = await parseForm(request);
    const wordId = Number(form.get("word_id"));
    const jsonData = (form.get("json_data") || "").toString().trim();
    const returnTo = (form.get("return_to") || "").toString().trim();

    if (!wordId) return htmlResponse("شناسه واژه نامعتبر است.", 400);

    let questionsArray: unknown[] = []; // unknown — value comes from JSON.parse of user input
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
      // item is unknown — value comes from JSON.parse of user input
      const entry = item as Record<string, unknown>;
      if (entry.questionText && Array.isArray(entry.options) && entry.options.length === 4 && typeof entry.correctIndex === 'number') {
        validQuestions.push({
          wordId: wordId,
          questionText: entry.questionText as string,
          options: entry.options as string[],
          correctIndex: entry.correctIndex,
          explanation: (entry.explanation as string) || "",
          questionStyle: (entry.questionStyle as string) || "en_to_fa",
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
    const word = await queryOne<WordRow>(env, `SELECT * FROM words WHERE id = ?`, [id]);
    if (!word) return htmlResponse("واژه پیدا نشد.", 404);
    const prevWord = await queryOne<{ id: number }>(env, `SELECT id FROM words WHERE id > ? ORDER BY id ASC LIMIT 1`, [id]);
    const nextWord = await queryOne<{ id: number }>(env, `SELECT id FROM words WHERE id < ? ORDER BY id DESC LIMIT 1`, [id]);
    const navigation = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
        ${prevWord ? `<a href="/admin/words/edit?id=${prevWord.id}"><button type="button" class="secondary">واژه قبلی</button></a>` : ""}
        ${nextWord ? `<a href="/admin/words/edit?id=${nextWord.id}"><button type="button" class="secondary">واژه بعدی</button></a>` : ""}
      </div>
    `;
    const questions = await queryAll<WordQuestionRow>(env, "SELECT * FROM word_questions WHERE word_id = ? ORDER BY id DESC", [id]);
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

  if (request.method === "POST" && url.pathname === "/admin/words/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));

    if (id) {
      await execute(env, `DELETE FROM word_question_reports WHERE question_id IN (SELECT id FROM word_questions WHERE word_id = ?)`, [id]);
      await execute(env, `DELETE FROM user_word_question_history WHERE word_id = ?`, [id]);
      await execute(env, `DELETE FROM user_words_sm2 WHERE word_id = ?`, [id]);
      await execute(env, `DELETE FROM word_questions WHERE word_id = ?`, [id]);
      await execute(env, `DELETE FROM words WHERE id = ?`, [id]);
    }
    
    return redirect("/admin/words");
  }

  return null;
}

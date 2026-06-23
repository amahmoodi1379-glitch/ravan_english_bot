import { Env } from "../../types";
import { queryAll, queryOne, execute } from "../../db/client";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../../utils/response";
import { renderAdminLayout, renderTextForm } from "../views";
import { insertTextQuestions } from "../../db/texts";
import { parseAndValidateQuestionForm, getQuestionRedirectPath } from "../utils";
import { ADMIN_LIST_PAGE_SIZE } from "../../config/constants";

interface TextListRow {
  id: number;
  title: string;
  snippet: string | null;
  level: number | null;
  is_active: number;
  has_test: number;
}

interface TextRow {
  id: number;
  title: string;
  body_en: string;
  level: number | null;
  is_active: number;
}

interface TextQuestionRow {
  id: number;
  text_id: number;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: string;
  explanation_text: string | null;
  source: string;
  question_type: string;
}

/**
 * Handle admin routes for reading text CRUD and text question management.
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not a text route
 */
export async function handleTextRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/admin/texts") {
    const search = (url.searchParams.get("q") || "").trim();
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;

    const page = Math.min(rawPage, 1000000);
    const limit = ADMIN_LIST_PAGE_SIZE;
    const offset = (page - 1) * limit;

    const fromSql = "FROM reading_texts t";
    let whereSql = "WHERE 1 = 1";
    const baseParams: unknown[] = [];
    if (search) {
      whereSql += " AND (t.title LIKE ? OR t.body_en LIKE ?)";
      baseParams.push(`%${search}%`, `%${search}%`);
    }

    const countRow = await queryOne<{ total: number }>(env, `SELECT COUNT(*) as total ${fromSql} ${whereSql}`, baseParams);
    const totalCount = countRow?.total || 0;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const texts = await queryAll<TextListRow>(
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
    const rowsHtml = texts.map((t) => `
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
    const textRow = await queryOne<TextRow>(env, `SELECT * FROM reading_texts WHERE id = ?`, [id]);
    if (!textRow) return htmlResponse("متن پیدا نشد.", 404);
    const prevText = await queryOne<{ id: number }>(env, `SELECT id FROM reading_texts WHERE id > ? ORDER BY id ASC LIMIT 1`, [id]);
    const nextText = await queryOne<{ id: number }>(env, `SELECT id FROM reading_texts WHERE id < ? ORDER BY id DESC LIMIT 1`, [id]);
    const navigation = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
        ${prevText ? `<a href="/admin/texts/edit?id=${prevText.id}"><button type="button" class="secondary">متن قبلی</button></a>` : ""}
        ${nextText ? `<a href="/admin/texts/edit?id=${nextText.id}"><button type="button" class="secondary">متن بعدی</button></a>` : ""}
      </div>
    `;
    const questions = await queryAll<TextQuestionRow>(env, "SELECT id, text_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, source, COALESCE(question_type, 'reading') AS question_type FROM text_questions WHERE text_id = ? ORDER BY id DESC", [id]);
    return htmlResponse(renderAdminLayout("ویرایش متن", `${navigation}${renderTextForm(textRow, "ویرایش متن", questions)}`, "texts"));
  }

  if (url.pathname === "/admin/texts/questions") {
    const textId = Number(url.searchParams.get("text_id"));
    if (!textId) return htmlResponse("شناسه متن نامعتبر است.", 400);
    const text = await queryOne<TextRow>(env, "SELECT * FROM reading_texts WHERE id = ?", [textId]);
    if (!text) return htmlResponse("متن پیدا نشد.", 404);
    const questions = await queryAll<TextQuestionRow>(env, "SELECT *, COALESCE(question_type, 'reading') AS question_type FROM text_questions WHERE text_id = ? ORDER BY id DESC", [textId]);

    const questionsHtml = questions.length === 0 ? "<p>هنوز سوالی برای این متن ثبت نشده است.</p>" : questions.map((q) => `
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

    const questionData = validation.data;
    await execute(
      env,
      `INSERT INTO text_questions (text_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation_text, question_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [textId, questionData.questionText, questionData.optionA, questionData.optionB, questionData.optionC, questionData.optionD, questionData.correctOption, questionData.explanationText, questionData.questionStyle, questionData.source]
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

    const questionData = validation.data;
    await execute(
      env,
      `UPDATE text_questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=?, explanation_text=?, question_type=?, source=? WHERE id=? AND text_id=?`,
      [questionData.questionText, questionData.optionA, questionData.optionB, questionData.optionC, questionData.optionD, questionData.correctOption, questionData.explanationText, questionData.questionStyle, questionData.source, id, textId]
    );

    return redirect(getQuestionRedirectPath("text", textId, returnTo));
  }

  if (request.method === "POST" && url.pathname === "/admin/texts/questions/import_json") {
    const form = await parseForm(request);
    const textId = Number(form.get("text_id"));
    const jsonData = (form.get("json_data") || "").toString().trim();
    const returnTo = (form.get("return_to") || "").toString().trim();

    if (!textId) return htmlResponse("شناسه متن نامعتبر است.", 400);

    const text = await queryOne<{ id: number }>(env, "SELECT id FROM reading_texts WHERE id = ?", [textId]);
    if (!text) return htmlResponse("متن پیدا نشد.", 404);

    let questionsArray: unknown[] = []; // unknown — value comes from JSON.parse of user input
    try {
      questionsArray = JSON.parse(jsonData);
    } catch (e) {
      return htmlResponse(renderAdminLayout("خطا", '<div class="error" style="color:red; padding:20px;">فرمت JSON اشتباه است. لطفا چک کنید ویرگول یا پرانتز کم و زیاد نباشد.</div>', "texts"), 400);
    }

    if (!Array.isArray(questionsArray)) {
      return htmlResponse(renderAdminLayout("خطا", '<div class="error">ورودی باید یک لیست [] باشد.</div>', "texts"), 400);
    }

    const validQuestions = [];
    for (const item of questionsArray) {
      // item is unknown — value comes from JSON.parse of user input
      const entry = item as Record<string, unknown>;
      if (entry.questionText && Array.isArray(entry.options) && entry.options.length === 4 && typeof entry.correctIndex === 'number') {
        validQuestions.push({
          questionText: entry.questionText as string,
          options: entry.options as string[],
          correctIndex: entry.correctIndex,
          explanation: (entry.explanation as string) || "",
          questionType: (entry.questionType as string) || "reading",
          source: "manual" as const
        });
      }
    }

    if (validQuestions.length > 0) {
      await insertTextQuestions(env, textId, validQuestions);
    }

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

  if (request.method === "POST" && url.pathname === "/admin/texts/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));

    if (id) {
      await execute(env, `DELETE FROM user_text_question_history WHERE question_id IN (SELECT id FROM text_questions WHERE text_id = ?)`, [id]);
      await execute(env, `DELETE FROM text_questions WHERE text_id = ?`, [id]);
      await execute(env, `DELETE FROM reading_sessions WHERE text_id = ?`, [id]);
      await execute(env, `DELETE FROM reading_texts WHERE id = ?`, [id]);
    }

    return redirect("/admin/texts");
  }

  // Not a text route
  return null;
}

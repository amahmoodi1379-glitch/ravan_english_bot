import { Env } from "../types";
import { queryAll, queryOne, execute } from "../db/client";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../utils/response";
import { renderAdminLayout, renderWordForm, renderTextForm, renderUserForm } from "./views";

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
    const form = await parseForm(request);
    const password = (form.get("password") || "").toString();
    const expected = env.ADMIN_PASSWORD || "";

    if (!expected || password !== expected) {
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

  // --- مدیریت واژه‌ها ---
  if (url.pathname === "/admin/words") {
    const search = (url.searchParams.get("q") || "").trim();
    let sql = `SELECT id, english, persian, level, lesson_name, is_active FROM words WHERE 1 = 1`;
    const params: any[] = [];
    if (search) {
      sql += ` AND (english LIKE ? OR persian LIKE ? OR lesson_name LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ` ORDER BY id DESC LIMIT 100`;
    const words = await queryAll<any>(env, sql, params);

    const rowsHtml = words.map((w: any) => `
      <tr>
        <td>${w.id}</td>
        <td>${escapeHtml(w.english)}</td>
        <td>${escapeHtml(w.persian)}</td>
        <td>${w.level}</td>
        <td>${w.lesson_name ? escapeHtml(w.lesson_name) : "-"}</td>
        <td><span class="${w.is_active ? "badge active" : "badge inactive"}">${w.is_active ? "فعال" : "غیرفعال"}</span></td>
        <td class="actions">
          <a href="/admin/words/edit?id=${w.id}">ویرایش</a>
          <a href="/admin/words/questions?word_id=${w.id}">سوالات</a>
        </td>
      </tr>
    `).join("");

    const content = `
      <div class="top-row">
        <form method="get" action="/admin/words" style="flex:1; display:flex; gap:8px;">
          <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:200px;" />
          <button type="submit" class="secondary">جستجو</button>
        </form>
        <div><a href="/admin/words/new"><button type="button">+ واژه‌ی جدید</button></a></div>
      </div>
      <table><thead><tr><th>ID</th><th>English</th><th>معنی فارسی</th><th>Level</th><th>درس</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='7'>هیچ واژه‌ای پیدا نشد.</td></tr>"}</tbody></table>
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

  if (request.method === "POST" && url.pathname === "/admin/words/questions/delete") {
    const form = await parseForm(request);
    const id = Number(form.get("id"));
    const wordId = Number(form.get("word_id"));
    if (id) await execute(env, "DELETE FROM word_questions WHERE id = ?", [id]);
    return redirect(`/admin/words/questions?word_id=${wordId}`);
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
    return htmlResponse(renderAdminLayout("ویرایش واژه", renderWordForm(word, "ویرایش واژه"), "words"));
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
    const texts = await queryAll<any>(env, `SELECT id, title, substr(body_en, 1, 120) AS snippet, level, is_active FROM reading_texts ORDER BY id DESC LIMIT 50`);
    const rowsHtml = texts.map((t: any) => `
      <tr>
        <td>${t.id}</td>
        <td>${escapeHtml(t.title)}</td>
        <td>${escapeHtml(t.snippet || "")}</td>
        <td>${t.level ?? "-"}</td>
        <td><span class="${t.is_active ? "badge active" : "badge inactive"}">${t.is_active ? "فعال" : "غیرفعال"}</span></td>
        <td class="actions"><a href="/admin/texts/edit?id=${t.id}">ویرایش</a></td>
      </tr>
    `).join("");
    const content = `
      <div class="top-row"><div></div><div><a href="/admin/texts/new"><button type="button">+ متن جدید</button></a></div></div>
      <table><thead><tr><th>ID</th><th>عنوان</th><th>پیش‌نمایش متن</th><th>Level</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='6'>هیچ متنی ثبت نشده.</td></tr>"}</tbody></table>
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
    return htmlResponse(renderAdminLayout("ویرایش متن", renderTextForm(textRow, "ویرایش متن"), "texts"));
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

  // --- مدیریت کاربران ---
  if (url.pathname === "/admin/users") {
    const search = (url.searchParams.get("q") || "").trim();
    let sql = `SELECT u.id, u.telegram_id, u.username, u.display_name, u.xp_total, u.created_at, u.is_approved, ac.code as license_code FROM users u LEFT JOIN access_codes ac ON ac.used_by_user_id = u.id WHERE 1 = 1`;
    const params: any[] = [];
    if (search) {
      sql += ` AND (u.display_name LIKE ? OR u.username LIKE ? OR cast(u.telegram_id as text) LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ` ORDER BY u.id DESC LIMIT 50`;
    const users = await queryAll<any>(env, sql, params);

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

    const content = `
      <div class="top-row">
        <form method="get" action="/admin/users" style="flex:1; display:flex; gap:8px;">
          <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:250px;" />
          <button type="submit" class="secondary">جستجو</button>
        </form>
      </div>
      <table><thead><tr><th>ID</th><th>Telegram</th><th>Username</th><th>نام</th><th>XP</th><th>عضویت</th><th>لایسنس</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='8'>یافت نشد.</td></tr>"}</tbody></table>
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

  return htmlResponse("Not Found", 404);
}

import { Env } from "./types";
import { handleTelegramUpdate, TelegramUpdate } from "./bot/router";
import { queryAll, queryOne, execute } from "./db/client";
import { getAllActiveReadingTexts } from "./db/texts";
import { cleanupOldMatches } from "./db/duels";

function htmlResponse(html: string, status: number = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location }
  });
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// بررسی اعتبار ادمین با چک کردن توکن در دیتابیس
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

async function parseForm(request: Request): Promise<URLSearchParams> {
  const bodyText = await request.text();
  return new URLSearchParams(bodyText);
}

function renderAdminLayout(title: string, content: string, section: string = ""): string {
  const nav = `
    <nav style="margin-bottom: 16px;">
      <a href="/admin/words" style="margin-right: 8px;${
        section === "words" ? " font-weight:bold;" : ""
      }">واژه‌ها</a>
      <a href="/admin/texts" style="margin-right: 8px;${
        section === "texts" ? " font-weight:bold;" : ""
      }">متن‌ها</a>
      <a href="/admin/users" style="margin-right: 8px;${   
        section === "users" ? " font-weight:bold;" : ""    
      }">کاربران</a>                                       <a href="/admin/logout" style="float: left;">خروج</a>
    </nav>
  `;

  return `<!doctype html>
<html lang="fa">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f7fb; margin:0; padding:20px; direction:rtl; }
    .container { max-width: 900px; margin: 0 auto; background:#fff; padding:20px 24px; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.06); }
    h1 { font-size:20px; margin-top:0; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border:1px solid #e0e0e0; padding:6px 8px; font-size:13px; text-align:right; }
    th { background:#fafafa; }
    input[type="text"], input[type="number"], input[type="password"], textarea, select {
      width:100%; padding:6px 8px; margin:4px 0 10px; border-radius:6px; border:1px solid #ccc; font-size:13px; box-sizing: border-box;
    }
    textarea { min_height:160px; font-family:inherit; }
    button { padding:6px 12px; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer; font-size:13px; }
    button.secondary { background:#6b7280; }
    button.danger { background:#dc2626; }
    .actions a { margin-right:6px; font-size:12px; text-decoration: none; color: #2563eb; }
    .badge { display:inline-block; padding:2px 6px; border-radius:999px; font-size:11px; background:#e5e7eb; }
    .badge.active { background:#dcfce7; color:#166534; }
    .badge.inactive { background:#fee2e2; color:#b91c1c; }
    .error { background:#fee2e2; color:#b91c1c; padding:8px 10px; border-radius:6px; margin-bottom:10px; font-size:13px; }
    .top-row { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom: 10px;}
    .q-box { border: 1px solid #eee; padding: 10px; border-radius: 8px; margin-bottom: 10px; background: #fafafa; }
    .q-meta { font-size: 11px; color: #666; margin-bottom: 4px; }
    .q-text { font-weight: bold; margin-bottom: 6px; }
    .q-opt { font-size: 12px; margin-right: 10px; }
    .q-correct { color: #166534; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>
    ${nav}
    ${content}
  </div>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // Global Error Handling
    try {
      // Telegram webhook
      if (request.method === "POST" && url.pathname === "/telegram/webhook") {
        const secretFromUrl = url.searchParams.get("secret");
        const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;

        if (expectedSecret && secretFromUrl !== expectedSecret) {
          return new Response("Forbidden", { status: 403 });
        }

        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch (_e) {
          return new Response("Bad Request", { status: 400 });
        }

        ctx.waitUntil(handleTelegramUpdate(env, update));
        return new Response("OK", { status: 200 });
      }

      // Debug: words
      if (request.method === "GET" && url.pathname === "/debug/db") {
        const words = await queryAll(
          env,
          "SELECT id, english, persian, level FROM words ORDER BY id LIMIT 20"
        );
        return new Response(JSON.stringify(words, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }

      // Admin: login page
      if (request.method === "GET" && url.pathname === "/admin") {
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

      // Admin: handle login (SECURE)
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

        // Generate Secure Token
        const token = crypto.randomUUID();
        // Expiration: 1 day from now
        const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();

        await execute(
          env,
          "INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)",
          [token, expiresAt]
        );

        const headers = new Headers();
        headers.append(
          "Set-Cookie",
          `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
        );
        headers.append("Location", "/admin/words");

        return new Response(null, { status: 302, headers });
      }

      // Admin: logout
      if (request.method === "GET" && url.pathname === "/admin/logout") {
        const token = getCookie(request, "admin_token");
        if (token) {
          await execute(env, "DELETE FROM admin_sessions WHERE token = ?", [token]);
        }

        const headers = new Headers();
        headers.append(
          "Set-Cookie",
          "admin_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        );
        headers.append("Location", "/admin");
        return new Response(null, { status: 302, headers });
      }

      // Admin: مدیریت واژه‌ها - لیست
      if (request.method === "GET" && url.pathname === "/admin/words") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const search = (url.searchParams.get("q") || "").trim();
        let sql = `
          SELECT id, english, persian, level, lesson_name, is_active
          FROM words
          WHERE 1 = 1
        `;
        const params: any[] = [];
        if (search) {
          sql += ` AND (english LIKE ? OR persian LIKE ? OR lesson_name LIKE ?)`;
          const like = `%${search}%`;
          params.push(like, like, like);
        }
        sql += ` ORDER BY id DESC LIMIT 100`;

        const words = await queryAll<any>(env, sql, params);

        const rowsHtml = words
          .map((w: any) => {
            const badgeClass = w.is_active ? "badge active" : "badge inactive";
            const badgeText = w.is_active ? "فعال" : "غیرفعال";
            return `
              <tr>
                <td>${w.id}</td>
                <td>${escapeHtml(w.english)}</td>
                <td>${escapeHtml(w.persian)}</td>
                <td>${w.level}</td>
                <td>${w.lesson_name ? escapeHtml(w.lesson_name) : "-"}</td>
                <td><span class="${badgeClass}">${badgeText}</span></td>
                <td class="actions">
                  <a href="/admin/words/edit?id=${w.id}">ویرایش</a>
                  <a href="/admin/words/questions?word_id=${w.id}">سوالات</a>
                </td>
              </tr>
            `;
          })
          .join("");

        const content = `
          <div class="top-row">
            <form method="get" action="/admin/words" style="flex:1; display:flex; gap:8px;">
              <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:200px;" />
              <button type="submit" class="secondary">جستجو</button>
            </form>
            <div>
              <a href="/admin/words/new">
                <button type="button">+ واژه‌ی جدید</button>
              </a>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>English</th>
                <th>معنی فارسی</th>
                <th>Level</th>
                <th>درس</th>
                <th>وضعیت</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || "<tr><td colspan='7'>هیچ واژه‌ای پیدا نشد.</td></tr>"}
            </tbody>
          </table>
        `;

        return htmlResponse(renderAdminLayout("مدیریت واژه‌ها", content, "words"));
      }

      // Admin: مدیریت سوالات یک واژه
      if (request.method === "GET" && url.pathname === "/admin/words/questions") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const wordIdParam = url.searchParams.get("word_id");
        const wordId = wordIdParam ? Number(wordIdParam) : 0;
        if (!wordId) return htmlResponse("شناسه واژه نامعتبر است.", 400);

        const word = await queryOne<any>(env, "SELECT * FROM words WHERE id = ?", [wordId]);
        if (!word) return htmlResponse("واژه پیدا نشد.", 404);

        const questions = await queryAll<any>(
          env, 
          "SELECT * FROM word_questions WHERE word_id = ? ORDER BY id DESC", 
          [wordId]
        );

        let questionsHtml = "";
        if (questions.length === 0) {
          questionsHtml = "<p>هنوز سوالی برای این واژه ثبت نشده است.</p>";
        } else {
          questionsHtml = questions.map((q: any) => {
            return `
              <div class="q-box">
                <div class="q-meta">
                  ID: ${q.id} | Style: ${q.question_style} | Source: ${q.source} | Created: ${q.created_at.substring(0, 10)}
                </div>
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
            `;
          }).join("");
        }

        const content = `
          <div style="margin-bottom:12px;">
            <a href="/admin/words">← بازگشت به لیست واژه‌ها</a>
          </div>
          <h2>سوالات واژه‌ی: <span style="color:#2563eb;">${escapeHtml(word.english)}</span> (${escapeHtml(word.persian)})</h2>
          ${questionsHtml}
        `;

        return htmlResponse(renderAdminLayout(`سوالات: ${word.english}`, content, "words"));
      }

      // Admin: حذف سوال
      if (request.method === "POST" && url.pathname === "/admin/words/questions/delete") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }
        const form = await parseForm(request);
        const id = Number(form.get("id"));
        const wordId = Number(form.get("word_id"));

        if (id) {
          await execute(env, "DELETE FROM word_questions WHERE id = ?", [id]);
        }

        return redirect(`/admin/words/questions?word_id=${wordId}`);
      }

      // Admin: فرم ایجاد واژه جدید
      if (request.method === "GET" && url.pathname === "/admin/words/new") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const word = {
          id: "",
          english: "",
          persian: "",
          level: 1,
          lesson_name: "",
          synonyms: "",
          antonyms: "",
          is_active: 1
        };

        const content = renderWordForm(word, "ایجاد واژه جدید");
        return htmlResponse(renderAdminLayout("ایجاد واژه جدید", content, "words"));
      }

      // Admin: فرم ویرایش واژه
      if (request.method === "GET" && url.pathname === "/admin/words/edit") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const idParam = url.searchParams.get("id");
        const id = idParam ? Number(idParam) : 0;
        if (!id) {
          return htmlResponse("شناسه واژه نامعتبر است.", 400);
        }

        const word = await queryOne<any>(
          env,
          `
          SELECT id, english, persian, level, lesson_name, synonyms, antonyms, is_active
          FROM words
          WHERE id = ?
          `,
          [id]
        );

        if (!word) {
          return htmlResponse("واژه پیدا نشد.", 404);
        }

        const content = renderWordForm(word, "ویرایش واژه");
        return htmlResponse(renderAdminLayout("ویرایش واژه", content, "words"));
      }

      // Admin: ذخیره واژه
      if (request.method === "POST" && url.pathname === "/admin/words/save") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const form = await parseForm(request);
        const idStr = (form.get("id") || "").toString().trim();
        const english = (form.get("english") || "").toString().trim();
        const persian = (form.get("persian") || "").toString().trim();
        const levelStr = (form.get("level") || "1").toString().trim();
        const lessonName = (form.get("lesson_name") || "").toString().trim();
        const synonyms = (form.get("synonyms") || "").toString().trim();
        const antonyms = (form.get("antonyms") || "").toString().trim();
        const isActive = form.get("is_active") === "1" ? 1 : 0;

        if (!english || !persian) {
          const word = {
            id: idStr,
            english,
            persian,
            level: Number(levelStr) || 1,
            lesson_name: lessonName,
            synonyms,
            antonyms,
            is_active: isActive
          };
          const errorContent =
            '<div class="error">فیلدهای English و معنی فارسی الزامی هستند.</div>' +
            renderWordForm(word, idStr ? "ویرایش واژه" : "ایجاد واژه جدید");
          return htmlResponse(
            renderAdminLayout(idStr ? "ویرایش واژه" : "ایجاد واژه جدید", errorContent, "words"),
            400
          );
        }

        const level = Number(levelStr) || 1;
        const lessonValue = lessonName || null;
        const synonymsValue = synonyms || null;
        const antonymsValue = antonyms || null;

        if (idStr) {
          const id = Number(idStr);
          await execute(
            env,
            `
            UPDATE words
            SET english = ?, persian = ?, level = ?, lesson_name = ?, synonyms = ?, antonyms = ?, is_active = ?, updated_at = datetime('now')
            WHERE id = ?
            `,
            [english, persian, level, lessonValue, synonymsValue, antonymsValue, isActive, id]
          );
        } else {
          await execute(
            env,
            `
            INSERT INTO words (english, persian, level, lesson_name, synonyms, antonyms, order_index, is_active)
            VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(order_index), 0) + 1 FROM words), ?)
            `,
            [english, persian, level, lessonValue, synonymsValue, antonymsValue, isActive]
          );
        }

        return redirect("/admin/words");
      }

      // Admin: لیست متون
      if (request.method === "GET" && url.pathname === "/admin/texts") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const texts = await queryAll<any>(
          env,
          `
          SELECT id, title, substr(body_en, 1, 120) AS snippet, level, is_active
          FROM reading_texts
          ORDER BY id DESC
          LIMIT 50
          `
        );

        const rowsHtml = texts
          .map((t: any) => {
            const badgeClass = t.is_active ? "badge active" : "badge inactive";
            const badgeText = t.is_active ? "فعال" : "غیرفعال";
            return `
              <tr>
                <td>${t.id}</td>
                <td>${escapeHtml(t.title)}</td>
                <td>${escapeHtml(t.snippet || "")}</td>
                <td>${t.level ?? "-"}</td>
                <td><span class="${badgeClass}">${badgeText}</span></td>
                <td class="actions">
                  <a href="/admin/texts/edit?id=${t.id}">ویرایش</a>
                </td>
              </tr>
            `;
          })
          .join("");

        const content = `
          <div class="top-row">
            <div></div>
            <div>
              <a href="/admin/texts/new">
                <button type="button">+ متن جدید</button>
              </a>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>عنوان</th>
                <th>پیش‌نمایش متن</th>
                <th>Level</th>
                <th>وضعیت</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || "<tr><td colspan='6'>هیچ متنی ثبت نشده.</td></tr>"}
            </tbody>
          </table>
        `;

        return htmlResponse(renderAdminLayout("مدیریت متن‌ها", content, "texts"));
      }

      // Admin: فرم متن جدید
      if (request.method === "GET" && url.pathname === "/admin/texts/new") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const text = {
          id: "",
          title: "",
          body_en: "",
          level: "",
          is_active: 1
        };

        const content = renderTextForm(text, "ایجاد متن جدید");
        return htmlResponse(renderAdminLayout("ایجاد متن جدید", content, "texts"));
      }

      // Admin: فرم ویرایش متن
      if (request.method === "GET" && url.pathname === "/admin/texts/edit") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const idParam = url.searchParams.get("id");
        const id = idParam ? Number(idParam) : 0;
        if (!id) {
          return htmlResponse("شناسه متن نامعتبر است.", 400);
        }

        const textRow = await queryOne<any>(
          env,
          `
          SELECT id, title, body_en, level, is_active
          FROM reading_texts
          WHERE id = ?
          `,
          [id]
        );

        if (!textRow) {
          return htmlResponse("متن پیدا نشد.", 404);
        }

        const content = renderTextForm(textRow, "ویرایش متن");
        return htmlResponse(renderAdminLayout("ویرایش متن", content, "texts"));
      }

      // Admin: ذخیره متن
      if (request.method === "POST" && url.pathname === "/admin/texts/save") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const form = await parseForm(request);
        const idStr = (form.get("id") || "").toString().trim();
        const title = (form.get("title") || "").toString().trim();
        const bodyEn = (form.get("body_en") || "").toString().trim();
        const levelStr = (form.get("level") || "").toString().trim();
        const isActive = form.get("is_active") === "1" ? 1 : 0;

        if (!title || !bodyEn) {
          const textRow = {
            id: idStr,
            title,
            body_en: bodyEn,
            level: levelStr,
            is_active: isActive
          };
          const errorContent =
            '<div class="error">فیلدهای عنوان و متن انگلیسی الزامی هستند.</div>' +
            renderTextForm(textRow, idStr ? "ویرایش متن" : "ایجاد متن جدید");
          return htmlResponse(
            renderAdminLayout(idStr ? "ویرایش متن" : "ایجاد متن جدید", errorContent, "texts"),
            400
          );
        }

        const level = levelStr ? Number(levelStr) : null;

        if (idStr) {
          const id = Number(idStr);
          await execute(
            env,
            `
            UPDATE reading_texts
            SET title = ?, body_en = ?, level = ?, is_active = ?, updated_at = datetime('now')
            WHERE id = ?
            `,
            [title, bodyEn, level, isActive, id]
          );
        } else {
          await execute(
            env,
            `
            INSERT INTO reading_texts (title, body_en, level, is_active)
            VALUES (?, ?, ?, ?)
            `,
            [title, bodyEn, level, isActive]
          );
        }

        return redirect("/admin/texts");
      }

      // Admin: لیست کاربران (اضافه شده)
      if (request.method === "GET" && url.pathname === "/admin/users") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const search = (url.searchParams.get("q") || "").trim();
        let sql = `
          SELECT id, telegram_id, username, display_name, xp_total, created_at
          FROM users
          WHERE 1 = 1
        `;
        const params: any[] = [];
        if (search) {
          sql += ` AND (display_name LIKE ? OR username LIKE ? OR cast(telegram_id as text) LIKE ?)`;
          const like = `%${search}%`;
          params.push(like, like, like);
        }
        sql += ` ORDER BY id DESC LIMIT 50`;

        const users = await queryAll<any>(env, sql, params);

        const rowsHtml = users
          .map((u: any) => {
            return `
              <tr>
                <td>${u.id}</td>
                <td>${u.telegram_id}</td>
                <td>${u.username ? escapeHtml(u.username) : "-"}</td>
                <td>${escapeHtml(u.display_name || "")}</td>
                <td><b>${u.xp_total}</b></td>
                <td>${u.created_at.substring(0, 10)}</td>
                <td class="actions">
                  <a href="/admin/users/edit?id=${u.id}">ویرایش</a>
                </td>
              </tr>
            `;
          })
          .join("");

        const content = `
          <div class="top-row">
            <form method="get" action="/admin/users" style="flex:1; display:flex; gap:8px;">
              <input type="text" name="q" placeholder="جستجو (نام، آیدی تلگرام...)" value="${escapeHtml(search)}" style="margin:0; max-width:250px;" />
              <button type="submit" class="secondary">جستجو</button>
            </form>
          </div>

          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Telegram ID</th>
                <th>Username</th>
                <th>نام نمایشی</th>
                <th>XP</th>
                <th>عضویت</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || "<tr><td colspan='7'>هیچ کاربری پیدا نشد.</td></tr>"}
            </tbody>
          </table>
        `;

        return htmlResponse(renderAdminLayout("مدیریت کاربران", content, "users"));
      }

      // Admin: فرم ویرایش کاربر (اضافه شده)
      if (request.method === "GET" && url.pathname === "/admin/users/edit") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const idParam = url.searchParams.get("id");
        const id = idParam ? Number(idParam) : 0;
        if (!id) return htmlResponse("شناسه کاربر نامعتبر است.", 400);

        const userRow = await queryOne<any>(
          env,
          `SELECT * FROM users WHERE id = ?`,
          [id]
        );

        if (!userRow) return htmlResponse("کاربر پیدا نشد.", 404);

        const content = renderUserForm(userRow, "ویرایش کاربر");
        return htmlResponse(renderAdminLayout(`ویرایش کاربر ${userRow.id}`, content, "users"));
      }

      // Admin: ذخیره تغییرات کاربر (اضافه شده)
      if (request.method === "POST" && url.pathname === "/admin/users/save") {
        if (!(await isAdminAuthed(request, env))) {
          return redirect("/admin");
        }

        const form = await parseForm(request);
        const idStr = (form.get("id") || "").toString().trim();
        const displayName = (form.get("display_name") || "").toString().trim();
        const xpTotalStr = (form.get("xp_total") || "0").toString().trim();

        if (idStr) {
          const id = Number(idStr);
          const xpTotal = Number(xpTotalStr);
          
          await execute(
            env,
            `
            UPDATE users
            SET display_name = ?, xp_total = ?, updated_at = datetime('now')
            WHERE id = ?
            `,
            [displayName, xpTotal, id]
          );
        }

        return redirect("/admin/users");
      }

      // Root
      if (request.method === "GET" && url.pathname === "/") {
        return new Response("OK from ravan_english_bot Worker ✅", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      return new Response("Not found", { status: 404 });

 } catch (err: any) {
      console.error("Global Error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }, 
  // این بخش هر ساعت خودکار اجرا می‌شود
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil((async () => {
      console.log("🔄 Starting hourly cleanup job...");

      // ۱. پاکسازی دوئل‌های قدیمی (با تابع اصلاح شده)
      await cleanupOldMatches(env);
      
      // ۲. پاکسازی سشن‌های ادمین منقضی شده
      await execute(env, "DELETE FROM admin_sessions WHERE expires_at < datetime('now')");

      // ۳. [جدید] جلوگیری از انباشت لاگ‌ها: حذف لاگ‌های قدیمی‌تر از ۲ ماه
      // چون لیدربورد فقط تا ۳۰ روز را نیاز دارد، ۶۰ روز نگه می‌داریم که مطمئن باشیم
      await execute(
        env, 
        "DELETE FROM activity_log WHERE created_at < datetime('now', '-60 days')"
      );

      // ۴. [جدید] پاکسازی سشن‌های ریدینگ و رفلکشنِ رها شده (بعد از ۲۴ ساعت)
      // این‌ها فقط فضا اشغال می‌کنند و دیگر قابل ادامه دادن نیستند
      await execute(
        env,
        `DELETE FROM reading_sessions 
         WHERE status = 'in_progress' AND started_at < datetime('now', '-1 day')`
      );
      
      // نکته: سوالات ریدینگ (user_text_question_history) چون با CASCADE وصل نیستند، 
      // بهتر است دستی پاک شوند یا بپذیریم که به عنوان تاریخچه بمانند (برای آمار خوب است).
      // اما سشن خالی ارزشی ندارد.

      await execute(
        env,
        `DELETE FROM reflection_sessions 
         WHERE ai_score IS NULL AND created_at < datetime('now', '-1 day')`
      );
      
      console.log("✅ Cleanup job completed successfully.");
    })());
  }
};
function renderWordForm(word: any, heading: string): string {
  return `
    <h2>${escapeHtml(heading)}</h2>
    <form method="post" action="/admin/words/save">
      <input type="hidden" name="id" value="${word.id ?? ""}" />

      <label>واژه‌ی انگلیسی (English):</label>
      <input type="text" name="english" value="${escapeHtml(word.english || "")}" />

      <label>معنی فارسی:</label>
      <input type="text" name="persian" value="${escapeHtml(word.persian || "")}" />

      <label>Level (۱ تا ۴):</label>
      <select name="level">
        ${[1, 2, 3, 4]
          .map(
            (lvl) =>
              `<option value="${lvl}" ${
                Number(word.level || 1) === lvl ? "selected" : ""
              }>${lvl}</option>`
          )
          .join("")}
      </select>

      <label>نام درس (اختیاری):</label>
      <input type="text" name="lesson_name" value="${escapeHtml(word.lesson_name || "")}" />

      <label>مترادف‌ها (synonyms) - اختیاری، با کاما جدا کن:</label>
      <textarea name="synonyms" rows="2">${escapeHtml(word.synonyms || "")}</textarea>

      <label>متضادها (antonyms) - اختیاری، با کاما جدا کن:</label>
      <textarea name="antonyms" rows="2">${escapeHtml(word.antonyms || "")}</textarea>

      <label>
        <input type="checkbox" name="is_active" value="1" ${
          word.is_active ? "checked" : ""
        } />
        فعال باشد
      </label>

      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        <button type="submit">ذخیره</button>
        <a href="/admin/words"><button type="button" class="secondary">انصراف</button></a>
      </div>
    </form>
  `;
}

function renderTextForm(text: any, heading: string): string {
  return `
    <h2>${escapeHtml(heading)}</h2>
    <form method="post" action="/admin/texts/save">
      <input type="hidden" name="id" value="${text.id ?? ""}" />

      <label>عنوان متن:</label>
      <input type="text" name="title" value="${escapeHtml(text.title || "")}" />

      <label>متن انگلیسی:</label>
      <textarea name="body_en">${escapeHtml(text.body_en || "")}</textarea>

      <label>Level (اختیاری):</label>
      <input type="number" name="level" value="${escapeHtml(
        text.level !== undefined && text.level !== null ? String(text.level) : ""
      )}" />

      <label>
        <input type="checkbox" name="is_active" value="1" ${
          text.is_active ? "checked" : ""
        } />
        فعال باشد
      </label>

      <div style="margin-top:12px;">
        <button type="submit">ذخیره</button>
        <a href="/admin/texts"><button type="button" class="secondary">انصراف</button></a>
      </div>
    </form>
  `;
}

function renderUserForm(user: any, heading: string): string {
  return `
    <h2>${escapeHtml(heading)}</h2>
    <div style="background:#eee; padding:10px; border-radius:6px; margin-bottom:10px; font-size:12px;">
      <b>اطلاعات ثابت:</b><br/>
      Telegram ID: ${user.telegram_id}<br/>
      Username: ${user.username || "-"}<br/>
      نام اصلی: ${user.first_name || ""} ${user.last_name || ""}
    </div>

    <form method="post" action="/admin/users/save">
      <input type="hidden" name="id" value="${user.id}" />

      <label>نام نمایشی (Display Name):</label>
      <input type="text" name="display_name" value="${escapeHtml(user.display_name || "")}" />

      <label>مجموع امتیاز (XP):</label>
      <input type="number" name="xp_total" value="${user.xp_total}" />

      <div style="margin-top:12px;">
        <button type="submit">ذخیره تغییرات</button>
        <a href="/admin/users"><button type="button" class="secondary">انصراف</button></a>
      </div>
    </form>
  `;
}

import { Env } from "./types";
import { handleTelegramUpdate, TelegramUpdate } from "./bot/router";
import { queryAll, queryOne, execute } from "./db/client";
import { getAllActiveReadingTexts } from "./db/texts";
import { generateWordQuestionsWithGemini } from "./ai/gemini";
import { insertWordQuestions } from "./db/word_questions";

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

function isAdminAuthed(request: Request): boolean {
  return getCookie(request, "admin_auth") === "1";
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
      <a href="/admin/logout" style="float: left;">خروج</a>
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
      width:100%; padding:6px 8px; margin:4px 0 10px; border-radius:6px; border:1px solid #ccc; font-size:13px;
    }
    textarea { min_height:160px; font-family:inherit; }
    button { padding:6px 12px; border-radius:6px; border:none; background:#2563eb; color:#fff; cursor:pointer; font-size:13px; }
    button.secondary { background:#6b7280; }
    .actions a { margin-right:6px; font-size:12px; }
    .badge { display:inline-block; padding:2px 6px; border-radius:999px; font-size:11px; background:#e5e7eb; }
    .badge.active { background:#dcfce7; color:#166534; }
    .badge.inactive { background:#fee2e2; color:#b91c1c; }
    .error { background:#fee2e2; color:#b91c1c; padding:8px 10px; border-radius:6px; margin-bottom:10px; font-size:13px; }
    .top-row { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
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
      try {
        const words = await queryAll(
          env,
          "SELECT id, english, persian, level FROM words ORDER BY id LIMIT 20"
        );
        return new Response(JSON.stringify(words, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response("DB error: " + String(err), { status: 500 });
      }
    }

    // Debug: reading texts
    if (request.method === "GET" && url.pathname === "/debug/reading-texts") {
      try {
        const texts = await getAllActiveReadingTexts(env);
        return new Response(JSON.stringify(texts, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response("Reading DB error: " + String(err), { status: 500 });
      }
    }

    // Debug: users
    if (request.method === "GET" && url.pathname === "/debug/users") {
      try {
        const users = await queryAll(
          env,
          `
          SELECT id, telegram_id, display_name, xp_total
          FROM users
          ORDER BY id ASC
          `
        );
        return new Response(JSON.stringify(users, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      } catch (err: any) {
        return new Response("Users DB error: " + String(err), { status: 500 });
      }
    }

    // Admin: login page
    if (request.method === "GET" && url.pathname === "/admin") {
      if (isAdminAuthed(request)) {
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

    // Admin: handle login
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

      const headers = new Headers();
      headers.append(
        "Set-Cookie",
        "admin_auth=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400"
      );
      headers.append("Location", "/admin/words");

      return new Response(null, { status: 302, headers });
    }

    // Admin: logout
    if (request.method === "GET" && url.pathname === "/admin/logout") {
      const headers = new Headers();
      headers.append(
        "Set-Cookie",
        "admin_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      );
      headers.append("Location", "/admin");
      return new Response(null, { status: 302, headers });
    }

    // Admin: مدیریت واژه‌ها - لیست
    if (request.method === "GET" && url.pathname === "/admin/words") {
      if (!isAdminAuthed(request)) {
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
              </td>
            </tr>
          `;
        })
        .join("");

      const content = `
        <div class="top-row">
          <form method="get" action="/admin/words">
            <input type="text" name="q" placeholder="جستجو بر اساس واژه / معنی / درس" value="${escapeHtml(
              search
            )}" />
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

    // Admin: فرم ایجاد واژه جدید
    if (request.method === "GET" && url.pathname === "/admin/words/new") {
      if (!isAdminAuthed(request)) {
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
      if (!isAdminAuthed(request)) {
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

    // Admin: ساخت سوال با AI برای یک واژه
    if (request.method === "GET" && url.pathname === "/admin/words/generate-questions") {
      if (!isAdminAuthed(request)) {
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
        SELECT id, english, persian, level
        FROM words
        WHERE id = ?
        `,
        [id]
      );

      if (!word) {
        return htmlResponse("واژه پیدا نشد.", 404);
      }

      const level = Number(word.level || 1);
      const styles = [
        "fa_meaning",
        "en_definition",
        "word_from_definition",
        "synonym",
        "antonym",
        "fa_to_en"
      ];

      let totalCreated = 0;

      for (const style of styles) {
        try {
          const generated = await generateWordQuestionsWithGemini({
            env,
            english: word.english,
            persian: word.persian,
            level,
            questionStyle: style,
            count: 2
          });

          if (generated.length > 0) {
            await insertWordQuestions(
              env,
              word.id,
              generated.map((g) => ({
                wordId: word.id,
                questionText: g.question,
                options: g.options,
                correctIndex: g.correctIndex,
                explanation: g.explanation,
                questionStyle: style
              }))
            );
            totalCreated += generated.length;
          }
        } catch (err) {
          console.error("AI generation failed for style", style, err);
        }
      }

      const content = `
        <p>تعداد <b>${totalCreated}</b> سوال جدید با کمک AI برای واژه‌ی <b>${escapeHtml(
        word.english
      )}</b> ساخته شد.</p>
        <p><a href="/admin/words/edit?id=${word.id}">برگشت به ویرایش واژه</a></p>
        <p><a href="/admin/words">برگشت به لیست واژه‌ها</a></p>
      `;
      return htmlResponse(renderAdminLayout("نتیجه ساخت سوال با AI", content, "words"));
    }

    // Admin: ذخیره واژه
    if (request.method === "POST" && url.pathname === "/admin/words/save") {
      if (!isAdminAuthed(request)) {
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
      if (!isAdminAuthed(request)) {
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
      if (!isAdminAuthed(request)) {
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
      if (!isAdminAuthed(request)) {
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
      if (!isAdminAuthed(request)) {
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

    // Root
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK from ravan_english_bot Worker ✅", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    return new Response("Not found", { status: 404 });
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
        ${
          word.id
            ? `<a href="/admin/words/generate-questions?id=${word.id}">
                 <button type="button">ساخت سوال با AI</button>
               </a>`
            : ""
        }
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

import { escapeHtml } from "../utils/response";

export function renderAdminLayout(title: string, content: string, section: string = ""): string {
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
      }">کاربران</a>
      <a href="/admin/licenses" style="margin-right: 8px;${
        section === "licenses" ? " font-weight:bold;" : ""
      }">لایسنس‌ها</a>
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

function renderQuestionManager(
  type: "word" | "text",
  parentId: number,
  questions: any[] = [],
  styleValueKey: string = "question_style"
): string {
  const basePath = type === "word" ? "/admin/words/questions" : "/admin/texts/questions";
  const parentField = type === "word" ? "word_id" : "text_id";
  const heading = type === "word" ? "مدیریت تست واژه" : "مدیریت تست متن";
  const styleLabel = type === "word" ? "سبک سوال" : "نوع/سبک سوال";

  const listHtml = questions.length === 0
    ? "<p>هنوز سوالی ثبت نشده است.</p>"
    : questions.map((q: any) => {
      const styleValue = q[styleValueKey] || "";
      return `
        <div class="q-box">
          <div class="q-meta">ID: ${q.id} | ${escapeHtml(styleLabel)}: ${escapeHtml(styleValue || "-")} | Source: ${escapeHtml(q.source || "-")}</div>
          <form method="post" action="${basePath}/update">
            <input type="hidden" name="id" value="${q.id}" />
            <input type="hidden" name="${parentField}" value="${parentId}" />
            <input type="hidden" name="return_to" value="edit" />
            <input type="hidden" name="source" value="manual" />
            <label>متن سوال:</label>
            <textarea name="question_text" rows="2">${escapeHtml(q.question_text || "")}</textarea>
            <label>گزینه A:</label>
            <input type="text" name="option_a" value="${escapeHtml(q.option_a || "")}" />
            <label>گزینه B:</label>
            <input type="text" name="option_b" value="${escapeHtml(q.option_b || "")}" />
            <label>گزینه C:</label>
            <input type="text" name="option_c" value="${escapeHtml(q.option_c || "")}" />
            <label>گزینه D:</label>
            <input type="text" name="option_d" value="${escapeHtml(q.option_d || "")}" />
            <label>گزینه صحیح:</label>
            <select name="correct_option">
              ${["A", "B", "C", "D"].map((opt) => `<option value="${opt}" ${q.correct_option === opt ? "selected" : ""}>${opt}</option>`).join("")}
            </select>
            <label>${escapeHtml(styleLabel)}:</label>
            <select name="question_style">
              <option value="en_to_fa" ${styleValue === 'en_to_fa' ? 'selected' : ''}>نوع ۱: انگلیسی به فارسی</option>
              <option value="fa_to_en" ${styleValue === 'fa_to_en' ? 'selected' : ''}>نوع ۲: فارسی به انگلیسی</option>
              <option value="definition_to_word" ${styleValue === 'definition_to_word' ? 'selected' : ''}>نوع ۳: تعریف به واژه</option>
              <option value="word_to_definition" ${styleValue === 'word_to_definition' ? 'selected' : ''}>نوع ۴: واژه به تعریف</option>
              <option value="cloze" ${styleValue === 'cloze' ? 'selected' : ''}>نوع ۵: کلوز تست (جای خالی)</option>
            </select>
            <label>توضیح پاسخ (اختیاری):</label>
            <textarea name="explanation_text" rows="2">${escapeHtml(q.explanation_text || "")}</textarea>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
              <button type="submit">ذخیره تغییرات سوال</button>
          </form>
              <form method="post" action="${basePath}/delete" onsubmit="return confirm('آیا مطمئنی؟');" style="margin:0;">
                <input type="hidden" name="id" value="${q.id}" />
                <input type="hidden" name="${parentField}" value="${parentId}" />
                <input type="hidden" name="return_to" value="edit" />
                <button type="submit" class="danger">حذف سوال</button>
              </form>
            </div>
        </div>
      `;
    }).join("");

  return `
    <hr style="margin:20px 0;" />
    <h3>${heading}</h3>
    ${listHtml}

    <div class="q-box" style="border-style:dashed;">
      <h4 style="margin-top:0;">افزودن سوال جدید</h4>
      <form method="post" action="${basePath}/create">
        <input type="hidden" name="${parentField}" value="${parentId}" />
        <input type="hidden" name="return_to" value="edit" />
        <input type="hidden" name="source" value="manual" />
        <label>متن سوال:</label>
        <textarea name="question_text" rows="2"></textarea>
        <label>گزینه A:</label>
        <input type="text" name="option_a" />
        <label>گزینه B:</label>
        <input type="text" name="option_b" />
        <label>گزینه C:</label>
        <input type="text" name="option_c" />
        <label>گزینه D:</label>
        <input type="text" name="option_d" />
        <label>گزینه صحیح:</label>
        <select name="correct_option">
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
          <option value="D">D</option>
        </select>
        <label>${escapeHtml(styleLabel)}:</label>
        <select name="question_style">
          <option value="en_to_fa">نوع ۱: انگلیسی به فارسی</option>
          <option value="fa_to_en">نوع ۲: فارسی به انگلیسی</option>
          <option value="definition_to_word">نوع ۳: تعریف به واژه</option>
          <option value="word_to_definition">نوع ۴: واژه به تعریف</option>
          <option value="cloze">نوع ۵: کلوز تست (جای خالی)</option>
        </select>
        <label>توضیح پاسخ (اختیاری):</label>
        <textarea name="explanation_text" rows="2"></textarea>
        <button type="submit">افزودن سوال</button>
      </form>
    </div>
  `;
}

export function renderWordForm(word: any, heading: string, questions: any[] = []): string {
  const hasId = Number(word.id) > 0;
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
        ${[1, 2, 3, 4].map(lvl => `<option value="${lvl}" ${Number(word.level || 1) === lvl ? "selected" : ""}>${lvl}</option>`).join("")}
      </select>
      <label>نام درس (اختیاری):</label>
      <input type="text" name="lesson_name" value="${escapeHtml(word.lesson_name || "")}" />
      <label>مترادف‌ها (synonyms) - اختیاری، با کاما جدا کن:</label>
      <textarea name="synonyms" rows="2">${escapeHtml(word.synonyms || "")}</textarea>
      <label>متضادها (antonyms) - اختیاری، با کاما جدا کن:</label>
      <textarea name="antonyms" rows="2">${escapeHtml(word.antonyms || "")}</textarea>
      <label>
        <input type="checkbox" name="is_active" value="1" ${word.is_active ? "checked" : ""} />
        فعال باشد
      </label>
      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        <button type="submit">ذخیره</button>
        <a href="/admin/words"><button type="button" class="secondary">انصراف</button></a>
      </div>
    </form>
    ${hasId ? renderQuestionManager("word", Number(word.id), questions, "question_style") : ""}
  `;
}

export function renderTextForm(text: any, heading: string, questions: any[] = []): string {
  const hasId = Number(text.id) > 0;
  return `
    <h2>${escapeHtml(heading)}</h2>
    <form method="post" action="/admin/texts/save">
      <input type="hidden" name="id" value="${text.id ?? ""}" />
      <label>عنوان متن:</label>
      <input type="text" name="title" value="${escapeHtml(text.title || "")}" />
      <label>متن انگلیسی:</label>
      <textarea name="body_en">${escapeHtml(text.body_en || "")}</textarea>
      <label>Level (اختیاری):</label>
      <input type="number" name="level" value="${escapeHtml(text.level !== undefined && text.level !== null ? String(text.level) : "")}" />
      <label>
        <input type="checkbox" name="is_active" value="1" ${text.is_active ? "checked" : ""} />
        فعال باشد
      </label>
      <div style="margin-top:12px;">
        <button type="submit">ذخیره</button>
        <a href="/admin/texts"><button type="button" class="secondary">انصراف</button></a>
      </div>
    </form>
    ${hasId ? renderQuestionManager("text", Number(text.id), questions, "question_type") : ""}
  `;
}

export function renderUserForm(user: any, heading: string): string {
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
      <label style="margin-top:10px; display:block;">
        <input type="checkbox" name="is_approved" value="1" ${user.is_approved ? "checked" : ""} />
        کاربر تایید شده است (اجازه دسترسی دارد)
      </label>
      <div style="margin-top:12px;">
        <button type="submit">ذخیره تغییرات</button>
        <a href="/admin/users"><button type="button" class="secondary">انصراف</button></a>
      </div>
    </form>
  `;
}

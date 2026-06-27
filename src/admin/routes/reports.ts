import { Env } from "../../types";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../../utils/response";
import { renderAdminLayout } from "../views";
import {
  countReportedQuestions,
  getPaginatedReportedQuestions,
  resetWordQuestionReports,
} from "../../db/word_reports";
import { ADMIN_LIST_PAGE_SIZE } from "../../config/constants";

const STYLE_LABELS: Record<string, string> = {
  en_to_fa: "انگلیسی به فارسی",
  fa_to_en: "فارسی به انگلیسی",
  definition_to_word: "تعریف به واژه",
  word_to_definition: "واژه به تعریف",
  cloze: "کلوز (جای خالی)",
};

/** Truncate long question text for table display. */
function truncate(text: string, max = 90): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Handle admin routes for reviewing and clearing user-reported word-test questions.
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not a reports route
 */
export async function handleReportRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/admin/reports") {
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;
    const limit = ADMIN_LIST_PAGE_SIZE;

    const totalCount = await countReportedQuestions(env);
    const totalPages = Math.ceil(totalCount / limit) || 1;
    const page = Math.min(rawPage, totalPages);
    const offset = (page - 1) * limit;

    const rows = await getPaginatedReportedQuestions(env, limit, offset);

    const rowsHtml = rows.map((r) => {
      const styleLabel = STYLE_LABELS[r.question_style] || r.question_style || "-";
      return `
      <tr>
        <td style="text-align:center;"><span class="badge inactive" style="font-size:13px;">🚩 ${r.report_count}</span></td>
        <td>${escapeHtml(truncate(r.question_text))}</td>
        <td><b>${escapeHtml(r.english)}</b><br/><span style="font-size:11px; color:#666;">${escapeHtml(r.persian)}</span></td>
        <td style="font-size:12px;">${escapeHtml(styleLabel)}</td>
        <td style="font-size:11px; color:#666;">${escapeHtml(r.last_reported || "-")}</td>
        <td class="actions" style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
          <a href="/admin/words/edit?id=${r.word_id}">مشاهده/ویرایش</a>
          <form method="post" action="/admin/reports/reset" onsubmit="return confirm('شمارنده گزارش این سوال صفر شود؟ (سوابق گزارش این سوال پاک می‌شود)');" style="margin:0;">
            <input type="hidden" name="question_id" value="${r.question_id}" />
            <input type="hidden" name="page" value="${page}" />
            <button type="submit" class="secondary" style="padding:2px 6px; font-size:11px;">صفر کردن شمارنده</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const paginationHtml = `
      <div style="margin-top: 16px; display: flex; gap: 6px; align-items: center; justify-content: center; direction: ltr; flex-wrap: wrap;">
        ${page > 2 ? `<a href="/admin/reports?page=1"><button class="secondary" title="First Page">⏮ 1</button></a>` : ""}
        ${page > 1 ? `<a href="/admin/reports?page=${page - 1}"><button class="secondary">Previous</button></a>` : ""}
        <form method="get" action="/admin/reports" style="display:flex; align-items:center; gap:5px; margin:0;">
            <span style="font-size: 13px;">Page</span>
            <input type="number" name="page" value="${page}" min="1" max="${totalPages}" style="width: 60px; text-align: center; padding: 4px; margin: 0; border: 1px solid #ccc; border-radius: 4px;" />
            <span style="font-size: 13px;">of ${totalPages}</span>
            <button type="submit" class="secondary" style="padding: 4px 8px; font-size: 12px; background: #2563eb; color: white; border: none;">Go</button>
        </form>
        ${page < totalPages ? `<a href="/admin/reports?page=${page + 1}"><button class="secondary">Next</button></a>` : ""}
        ${page < totalPages - 1 ? `<a href="/admin/reports?page=${totalPages}"><button class="secondary" title="Last Page">${totalPages} ⏭</button></a>` : ""}
      </div>
      <div style="text-align: center; margin-top: 5px; font-size: 11px; color: #666;">مجموع سوالات گزارش‌شده: ${totalCount}</div>
    `;

    const content = `
      <p style="font-size:13px; color:#555;">سوالاتی که کاربران گزارش کرده‌اند، به‌ترتیب بیشترین تعداد گزارش. بعد از اصلاح سوال، شمارنده‌اش را صفر کن.</p>
      <table>
        <thead><tr><th>گزارش‌ها</th><th>متن سوال</th><th>واژه</th><th>نوع</th><th>آخرین گزارش</th><th>عملیات</th></tr></thead>
        <tbody>${rowsHtml || "<tr><td colspan='6'>هیچ سوال گزارش‌شده‌ای وجود ندارد. 🎉</td></tr>"}</tbody>
      </table>
      ${totalCount > 0 ? paginationHtml : ""}
    `;
    return htmlResponse(renderAdminLayout("سوالات گزارش‌شده", content, "reports"));
  }

  if (request.method === "POST" && url.pathname === "/admin/reports/reset") {
    const form = await parseForm(request);
    const questionId = Number(form.get("question_id"));
    let page = parseInt((form.get("page") || "1").toString());
    if (isNaN(page) || page < 1) page = 1;

    if (questionId) {
      await resetWordQuestionReports(env, questionId);
    }
    return redirect(`/admin/reports?page=${page}`);
  }

  return null;
}

import { Env } from "../../types";
import { queryAll, execute } from "../../db/client";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../../utils/response";
import { renderAdminLayout } from "../views";

interface LicenseRow {
  code: string;
  created_at: string;
  used_at: string | null;
  expiration_days: number | null;
  display_name: string | null;
  telegram_id: number | null;
}

/**
 * Handle admin routes for license code management (list and create).
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not a license route
 */
export async function handleLicenseRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  // GET /admin/licenses — license list
  if (url.pathname === "/admin/licenses") {
    const codes = await queryAll<LicenseRow>(env, `SELECT a.code, a.created_at, a.used_at, a.expiration_days, u.display_name, u.telegram_id FROM access_codes a LEFT JOIN users u ON u.id = a.used_by_user_id ORDER BY a.created_at DESC LIMIT 100`);
    const rows = codes.map((c) => {
      let expirationText = "نامحدود";
      if (c.expiration_days && c.expiration_days > 0) {
        if (c.used_at) {
          const usedAt = new Date(c.used_at).getTime();
          const expireAt = usedAt + c.expiration_days * 24 * 60 * 60 * 1000;
          const remainingDays = Math.ceil((expireAt - Date.now()) / (24 * 60 * 60 * 1000));
          expirationText = remainingDays > 0 ? `${remainingDays} روز مانده` : `<span class="badge inactive">منقضی</span>`;
        } else {
          expirationText = `${c.expiration_days} روز`;
        }
      }
      return `
      <tr>
        <td style="font-family:monospace;">${escapeHtml(c.code)}</td>
        <td>${c.used_at ? `<span class="badge inactive">استفاده شده: ${escapeHtml(c.display_name || String(c.telegram_id))}</span>` : `<span class="badge active">آزاد</span>`}</td>
        <td>${expirationText}</td>
        <td>${c.created_at.substring(0, 10)}</td>
      </tr>
    `;
    }).join("");

    const content = `
      <div class="top-row">
        <h3>مدیریت لایسنس‌ها</h3>
        <form method="post" action="/admin/licenses/create" style="display:flex; gap:8px; align-items:center;">
          <input type="text" name="new_code" placeholder="کد جدید..." required style="margin:0;" />
          <input type="number" name="expiration_days" placeholder="روز اعتبار" min="1" max="3650" style="margin:0; width:120px;" />
          <button type="submit">افزودن</button>
        </form>
      </div>
      <table><thead><tr><th>کد</th><th>وضعیت</th><th>اعتبار</th><th>تاریخ</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>خالی.</td></tr>"}</tbody></table>
    `;
    return htmlResponse(renderAdminLayout("لایسنس‌ها", content, "licenses"));
  }

  // POST /admin/licenses/create — create new license code
  if (request.method === "POST" && url.pathname === "/admin/licenses/create") {
    const form = await parseForm(request);
    const newCode = (form.get("new_code") || "").toString().trim();
    const daysStr = (form.get("expiration_days") || "").toString().trim();
    const parsedDays = daysStr ? parseInt(daysStr, 10) : null;
    const expirationDays = (parsedDays && !isNaN(parsedDays) && parsedDays > 0) ? parsedDays : null;
    if (newCode) {
      try {
        await execute(
          env,
          `INSERT INTO access_codes (code, expiration_days) VALUES (?, ?)`,
          [newCode, expirationDays]
        );
      } catch {}
    }
    return redirect("/admin/licenses");
  }

  // Not a license route
  return null;
}

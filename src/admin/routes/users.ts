import { Env } from "../../types";
import { queryAll, queryOne, execute } from "../../db/client";
import { htmlResponse, redirect, parseForm, escapeHtml } from "../../utils/response";
import { renderAdminLayout, renderUserForm } from "../views";
import { ADMIN_LIST_PAGE_SIZE } from "../../config/constants";

interface UserListRow {
  id: number;
  telegram_id: number;
  username: string | null;
  display_name: string;
  xp_total: number;
  created_at: string;
  is_approved: number;
  license_code: string | null;
}

interface UserRow {
  id: number;
  telegram_id: number;
  username: string | null;
  display_name: string;
  xp_total: number;
  created_at: string;
  is_approved: number;
  is_banned: number;
}

/**
 * Handle admin routes for user management (list, edit, save).
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not a user route
 */
export async function handleUserRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  // GET /admin/users — user list
  if (url.pathname === "/admin/users") {
    const search = (url.searchParams.get("q") || "").trim();
    const hideUnverified = url.searchParams.get("hide_unverified") === "1";
    let rawPage = parseInt(url.searchParams.get("page") || "1");
    if (isNaN(rawPage) || rawPage < 1) rawPage = 1;
    const page = Math.min(rawPage, 1000000);
    const limit = ADMIN_LIST_PAGE_SIZE;
    const offset = (page - 1) * limit;

    let whereSql = "FROM users u LEFT JOIN access_codes ac ON ac.used_by_user_id = u.id WHERE 1 = 1";
    const baseParams: unknown[] = [];

    if (search) {
      whereSql += ` AND (u.display_name LIKE ? OR u.username LIKE ? OR cast(u.telegram_id as text) LIKE ?)`;
      baseParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (hideUnverified) {
      whereSql += ` AND (ac.code IS NOT NULL OR u.is_approved = 1)`;
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

    const users = await queryAll<UserListRow>(env, dataSql, dataParams);

    const rowsHtml = users.map((u) => `
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

    const hideParam = hideUnverified ? "&hide_unverified=1" : "";
    const paginationHtml = `
      <div style="margin-top: 16px; display: flex; gap: 10px; align-items: center; justify-content: center; direction: ltr;">
        ${page > 1 ? `<a href="/admin/users?q=${encodeURIComponent(search)}${hideParam}&page=${page - 1}"><button class="secondary">Previous</button></a>` : ""}
        <span style="font-size: 13px; font-weight: bold;">Page ${page} of ${totalPages}</span>
        ${page < totalPages ? `<a href="/admin/users?q=${encodeURIComponent(search)}${hideParam}&page=${page + 1}"><button class="secondary">Next</button></a>` : ""}
      </div>
      <div style="text-align: center; margin-top: 5px; font-size: 11px; color: #666;">Total: ${totalCount} users</div>
    `;

    const content = `
      <div class="top-row">
        <form method="get" action="/admin/users" style="flex:1; display:flex; gap:8px; align-items:center;">
          <input type="text" name="q" placeholder="جستجو..." value="${escapeHtml(search)}" style="margin:0; max-width:250px;" />
          <button type="submit" class="secondary">جستجو</button>
          <label style="display:flex; align-items:center; gap:4px; font-size:13px; margin-inline-start:12px;">
            <input type="checkbox" name="hide_unverified" value="1" ${hideUnverified ? "checked" : ""} onchange="this.form.submit()" />
            مخفی کردن کاربران تایید نشده
          </label>
        </form>
      </div>
      <table><thead><tr><th>ID</th><th>Telegram</th><th>Username</th><th>نام</th><th>XP</th><th>عضویت</th><th>لایسنس</th><th>عملیات</th></tr></thead><tbody>${rowsHtml || "<tr><td colspan='8'>یافت نشد.</td></tr>"}</tbody></table>
      ${paginationHtml}
    `;
    return htmlResponse(renderAdminLayout("مدیریت کاربران", content, "users"));
  }

  // GET /admin/users/edit — user edit form
  if (url.pathname === "/admin/users/edit") {
    const id = Number(url.searchParams.get("id"));
    if (!id) return htmlResponse("شناسه نامعتبر", 400);
    const userRow = await queryOne<UserRow>(env, `SELECT * FROM users WHERE id = ?`, [id]);
    if (!userRow) return htmlResponse("کاربر پیدا نشد", 404);
    return htmlResponse(renderAdminLayout("ویرایش کاربر", renderUserForm(userRow, "ویرایش کاربر"), "users"));
  }

  // POST /admin/users/save — save user changes
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

  // Not a user route
  return null;
}

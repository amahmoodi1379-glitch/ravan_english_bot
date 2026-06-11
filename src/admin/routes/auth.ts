import { Env } from "../../types";
import { execute } from "../../db/client";
import { htmlResponse, redirect, parseForm } from "../../utils/response";
import { renderAdminLayout } from "../views";
import { getCookie, isAdminAuthed, isLoginRateLimited, recordLoginAttempt } from "../utils";
import { ADMIN_SESSION_TTL_MS, ADMIN_SESSION_TTL_SECONDS } from "../../config/constants";

/**
 * Handle authentication-related admin routes (login page, login POST, logout).
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding and secrets
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not an auth route
 */
export async function handleAuthRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  // GET /admin or GET /admin/ — login page (or redirect if already authed)
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
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

  // POST /admin/login — login form submission
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
    const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
    await execute(env, "INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)", [token, expiresAt]);
    
    const headers = new Headers();
    headers.append("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`);
    headers.append("Location", "/admin/words");
    return new Response(null, { status: 302, headers });
  }

  // GET /admin/logout — logout
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

  // Not an auth route
  return null;
}

import { Env } from "../types";
import { htmlResponse, redirect } from "../utils/response";
import { isAdminAuthed } from "./utils";
import { handleAuthRoutes } from "./routes/auth";
import { handleWordRoutes } from "./routes/words";
import { handleTextRoutes } from "./routes/texts";
import { handleUserRoutes } from "./routes/users";
import { handleLicenseRoutes } from "./routes/licenses";
import { handleReportRoutes } from "./routes/reports";
import { handleReviewRoutes } from "./routes/review";

/**
 * Handle incoming admin panel HTTP requests (CSRF check, auth, route delegation).
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding and secrets
 * @returns An HTTP Response for the admin panel
 */
export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // 1. CSRF validation for POST requests
  if (request.method === "POST") {
    const origin = request.headers.get("Origin");
    const referer = request.headers.get("Referer");

    if (origin && new URL(origin).hostname !== url.hostname) {
      return new Response("Forbidden (CSRF Origin Mismatch)", { status: 403 });
    }
    if (!origin && referer && new URL(referer).origin !== url.origin) {
      return new Response("Forbidden (CSRF Referer Mismatch)", { status: 403 });
    }
  }

  // 2. Auth routes (login, logout) — no auth required
  const authResponse = await handleAuthRoutes(request, env, url);
  if (authResponse) return authResponse;

  // 3. Auth guard — redirect unauthenticated users
  if (!(await isAdminAuthed(request, env))) {
    return redirect("/admin");
  }

  // 4. Delegate to domain route modules
  const wordResponse = await handleWordRoutes(request, env, url);
  if (wordResponse) return wordResponse;

  const textResponse = await handleTextRoutes(request, env, url);
  if (textResponse) return textResponse;

  const userResponse = await handleUserRoutes(request, env, url);
  if (userResponse) return userResponse;

  const licenseResponse = await handleLicenseRoutes(request, env, url);
  if (licenseResponse) return licenseResponse;

  const reportResponse = await handleReportRoutes(request, env, url);
  if (reportResponse) return reportResponse;

  const reviewResponse = await handleReviewRoutes(request, env, url);
  if (reviewResponse) return reviewResponse;

  // 5. No route matched
  return htmlResponse("Not Found", 404);
}

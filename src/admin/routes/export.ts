import { Env } from "../../types";
import { htmlResponse } from "../../utils/response";
import { renderAdminLayout } from "../views";
import { buildExportManifest, exportTableByName, fetchExportPart, renderExportPage } from "../full-export";
import { getSetting } from "../../db/settings";
import { setTransferMode, TRANSFER_MODE_KEY } from "../../bot/handlers/transfer";
import { renderTransferCard } from "../transfer-view";

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

/**
 * Full export for the Zabanyar web app (see full-export.ts). All three routes
 * sit behind the admin auth guard in admin/router.ts and only read.
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not an export route
 */
export async function handleExportRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  // POST /admin/export/transfer — turn transfer mode on or off (bot/handlers/transfer.ts)
  if (request.method === "POST" && url.pathname === "/admin/export/transfer") {
    const form = await request.formData();
    const mode = form.get("mode");
    if (mode !== "on" && mode !== "off") return new Response("Bad Request", { status: 400 });
    await setTransferMode(env, mode === "on");
    console.log(`transfer mode turned ${mode} from the admin panel`);
    return new Response(null, { status: 303, headers: { Location: "/admin/export" } });
  }

  if (request.method !== "GET") return null;

  // GET /admin/export — the transfer switch and the page with the «build export file» button
  if (url.pathname === "/admin/export") {
    const on = (await getSetting(env, TRANSFER_MODE_KEY)) === "on";
    return htmlResponse(renderAdminLayout("📦 خروجی کامل برای زبان‌یار", renderTransferCard(on) + renderExportPage(), "export"));
  }

  // GET /admin/export/manifest — table list with row counts (progress bar)
  if (url.pathname === "/admin/export/manifest") {
    return jsonResponse(await buildExportManifest(env));
  }

  // GET /admin/export/part?table=NAME&after=ROWID — one keyset page of one table
  if (url.pathname === "/admin/export/part") {
    const table = exportTableByName(url.searchParams.get("table") ?? "");
    if (!table) return jsonResponse({ error: "unknown_table" }, 400);
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) return jsonResponse({ error: "bad_cursor" }, 400);
    return jsonResponse(await fetchExportPart(env, table, after));
  }

  return null;
}

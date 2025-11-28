export function htmlResponse(html: string, status: number = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location }
  });
}

export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function parseForm(request: Request): Promise<URLSearchParams> {
  const bodyText = await request.text();
  return new URLSearchParams(bodyText);
}

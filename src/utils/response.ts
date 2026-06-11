/**
 * Create an HTML response with the given status code.
 * @param html - The HTML content to return as the response body
 * @param status - The HTTP status code (defaults to 200)
 * @returns A Response object with content-type text/html
 */
export function htmlResponse(html: string, status: number = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

/**
 * Create an HTTP 302 redirect response.
 * @param location - The URL to redirect the client to
 * @returns A Response object with status 302 and a Location header
 */
export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location }
  });
}

/**
 * Escape special HTML characters to prevent XSS injection.
 * @param str - The raw string to escape
 * @returns The escaped string safe for insertion into HTML
 */
export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Parse the body of a POST request as URL-encoded form data.
 * @param request - The incoming HTTP Request object
 * @returns A URLSearchParams instance containing the parsed form fields
 */
export async function parseForm(request: Request): Promise<URLSearchParams> {
  const bodyText = await request.text();
  return new URLSearchParams(bodyText);
}

import { Env } from "../types";
import { queryOne } from "../db/client";

const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

export type QuestionFormPayload = {
  questionText: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: "A" | "B" | "C" | "D";
  questionStyle: string;
  explanationText: string | null;
  source: "manual";
};

/**
 * Extract a cookie value from an HTTP request's Cookie header.
 * @param request - The incoming HTTP Request
 * @param name - The name of the cookie to extract
 * @returns The decoded cookie value, or null if not found
 */
export function getCookie(request: Request, name: string): string | null {
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

/**
 * Check whether the request carries a valid admin session token.
 * @param request - The incoming HTTP Request containing the admin_token cookie
 * @param env - The worker environment containing the D1 database binding
 * @returns True if a valid, non-expired admin session exists
 */
export async function isAdminAuthed(request: Request, env: Env): Promise<boolean> {
  const token = getCookie(request, "admin_token");
  if (!token) return false;
  const session = await queryOne<{ id: number }>(
    env,
    `SELECT id FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')`,
    [token]
  );
  return !!session;
}

/**
 * Check if a given IP address has exceeded the login attempt rate limit.
 * @param ip - The client IP address string
 * @returns True if the IP is currently rate-limited
 */
export function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= RATE_LIMIT_MAX;
}

/**
 * Record a failed login attempt for rate-limiting purposes.
 * @param ip - The client IP address string
 * @returns void
 */
export function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now - record.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    record.count++;
  }
}

/**
 * Parse and validate a question form submission from the admin panel.
 * @param form - The URL-encoded form data
 * @returns An object with either an error message or the validated QuestionFormPayload
 */
export function parseAndValidateQuestionForm(form: URLSearchParams): { error?: string; data?: QuestionFormPayload } {
  const questionText = (form.get("question_text") || "").toString().trim();
  const optionA = (form.get("option_a") || "").toString().trim();
  const optionB = (form.get("option_b") || "").toString().trim();
  const optionC = (form.get("option_c") || "").toString().trim();
  const optionD = (form.get("option_d") || "").toString().trim();
  const correctOptionRaw = (form.get("correct_option") || "").toString().trim().toUpperCase();
  const questionStyle = ((form.get("question_style") || form.get("question_type") || "").toString().trim());
  const explanationText = (form.get("explanation_text") || "").toString().trim() || null;
  const source = (form.get("source") || "").toString().trim();

  if (!questionText) return { error: "متن سوال الزامی است." };
  if (!optionA || !optionB || !optionC || !optionD) return { error: "تمام گزینه‌های A تا D الزامی هستند." };
  if (!["A", "B", "C", "D"].includes(correctOptionRaw)) return { error: "گزینه صحیح باید یکی از A/B/C/D باشد." };
  if (!questionStyle) return { error: "فیلد نوع/سبک سوال الزامی است." };
  if (source !== "manual") return { error: "منبع سوال باید manual باشد." };

  return {
    data: {
      questionText,
      optionA,
      optionB,
      optionC,
      optionD,
      correctOption: correctOptionRaw as "A" | "B" | "C" | "D",
      questionStyle,
      explanationText,
      source: "manual"
    }
  };
}

/**
 * Build the redirect path after a question form save based on the return-to context.
 * @param type - Whether the question belongs to a "word" or "text"
 * @param parentId - The ID of the parent word or text
 * @param returnTo - The context to redirect back to ("edit" or default list)
 * @returns The URL path string to redirect the client to
 */
export function getQuestionRedirectPath(type: "word" | "text", parentId: number, returnTo: string): string {
  if (returnTo === "edit") {
    return type === "word" ? `/admin/words/edit?id=${parentId}` : `/admin/texts/edit?id=${parentId}`;
  }
  return type === "word" ? `/admin/words/questions?word_id=${parentId}` : `/admin/texts/questions?text_id=${parentId}`;
}

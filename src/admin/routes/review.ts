import { Env } from "../../types";
import { htmlResponse, redirect, parseForm } from "../../utils/response";
import { renderAdminLayout, renderReviewPage, renderReviewResult } from "../views";
import {
  getReviewStats,
  getUnreviewedWordQuestionsBatch,
  markWordQuestionsReviewed,
  applyWordQuestionCorrections,
  resetWordQuestionReview,
  WordQuestionForReview
} from "../../db/word_questions";

/** Batch-size bounds for a review export. Round-two QC reviews 100 per turn. */
const EXPORT_MIN_SIZE = 1;
const EXPORT_MAX_SIZE = 1000;
const EXPORT_DEFAULT_SIZE = 100;

/** Shape of a single question as written to the downloadable review file. */
interface ReviewFileEntry {
  id: number;
  word: string;
  meaning: string;
  synonyms: string;
  antonyms: string;
  style: string;
  question: string;
  options: { A: string; B: string; C: string; D: string };
  correct: string;
  explanation: string;
}

/**
 * Map a DB review row to the downloadable file entry (options labelled A–D,
 * correct kept as the stored letter so the answer key is unambiguous).
 * @param q - A word question joined with its parent word
 * @returns The file entry for JSON serialization
 */
function toReviewFileEntry(q: WordQuestionForReview): ReviewFileEntry {
  return {
    id: q.id,
    word: q.english,
    meaning: q.persian,
    synonyms: q.synonyms || "",
    antonyms: q.antonyms || "",
    style: q.question_style,
    question: q.question_text,
    options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
    correct: q.correct_option,
    explanation: q.explanation_text || ""
  };
}

/**
 * Handle admin routes for batch quality-control review of word questions.
 * @param request - The incoming HTTP Request
 * @param env - The worker environment containing the D1 database binding
 * @param url - The parsed URL of the request
 * @returns A Response if the route was handled, or null if not a review route
 */
export async function handleReviewRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/admin/review") {
    const stats = await getReviewStats(env);
    return htmlResponse(renderAdminLayout("بازبینی کیفی", renderReviewPage(stats), "review"));
  }

  if (url.pathname === "/admin/review/export") {
    let size = parseInt(url.searchParams.get("size") || String(EXPORT_DEFAULT_SIZE), 10);
    if (isNaN(size)) size = EXPORT_DEFAULT_SIZE;
    size = Math.min(Math.max(size, EXPORT_MIN_SIZE), EXPORT_MAX_SIZE);

    const rows = await getUnreviewedWordQuestionsBatch(env, size);
    if (rows.length === 0) {
      return htmlResponse(
        renderAdminLayout(
          "بازبینی کیفی",
          '<div class="error">هیچ تست بازبینی‌نشده‌ای برای دانلود وجود ندارد.</div><div style="margin-top:12px;"><a href="/admin/review">← بازگشت</a></div>',
          "review"
        ),
        400
      );
    }

    const entries = rows.map(toReviewFileEntry);
    const body = JSON.stringify(entries, null, 2);

    // Mark this batch reviewed so the next download returns a fresh set.
    await markWordQuestionsReviewed(env, rows.map((r) => r.id));

    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="word_tests_review_${ts}.json"`
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/admin/review/apply") {
    const form = await parseForm(request);
    const jsonData = (form.get("corrections_json") || "").toString().trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonData);
    } catch (e) {
      return htmlResponse(
        renderAdminLayout(
          "خطا",
          '<div class="error">فرمت JSON اشتباه است. لطفاً خروجی هوش مصنوعی را دقیقاً (بدون متن اضافه یا code fence) پیست کن.</div><div style="margin-top:12px;"><a href="/admin/review">← بازگشت</a></div>',
          "review"
        ),
        400
      );
    }

    if (!Array.isArray(parsed)) {
      return htmlResponse(
        renderAdminLayout(
          "خطا",
          '<div class="error">ورودی باید یک آرایه [] باشد.</div><div style="margin-top:12px;"><a href="/admin/review">← بازگشت</a></div>',
          "review"
        ),
        400
      );
    }

    const result = await applyWordQuestionCorrections(env, parsed);
    return htmlResponse(renderAdminLayout("نتیجه‌ی اصلاحات", renderReviewResult(result), "review"));
  }

  if (request.method === "POST" && url.pathname === "/admin/review/reset") {
    await resetWordQuestionReview(env);
    return redirect("/admin/review");
  }

  return null;
}

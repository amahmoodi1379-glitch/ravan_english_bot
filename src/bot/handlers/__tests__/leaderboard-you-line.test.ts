import { describe, it, expect } from "vitest";
import { buildLeaderboardText } from "../leaderboard";

/**
 * The "📍 رتبه شما" line exists so a viewer who didn't make the visible top-50
 * still learns where they stand. It used to be suppressed whenever ANY listed row
 * happened to carry the same rank NUMBER as the viewer's — and since the board and
 * the rank are computed separately (different eligibility, and ties share a rank),
 * that collided constantly: a viewer absent from the board saw neither themselves
 * in the list nor their own rank. Presence is now decided by user id.
 */

const entries = [
  { rank: 1, user_id: 11, display_name: "A", avatar_code: null, score: 10 },
  { rank: 2, user_id: 22, display_name: "B", avatar_code: null, score: 5 },
  { rank: 3, user_id: 33, display_name: "C", avatar_code: null, score: 5 },
];

describe("buildLeaderboardText", () => {
  it("shows the viewer's rank when they are absent from the list", () => {
    // Rank 2 exists in the list, but it belongs to user 22 — not to this viewer.
    const text = buildLeaderboardText("t", entries, { rank: 2, score: 5 }, "روز", 99);
    expect(text).toContain("رتبه شما");
    expect(text).toContain("2");
  });

  it("omits the line when the viewer is already on the list", () => {
    const text = buildLeaderboardText("t", entries, { rank: 3, score: 5 }, "روز", 33);
    expect(text).not.toContain("رتبه شما");
  });

  it("omits the line for a zero score (a lapsed streak, or no XP this period)", () => {
    const text = buildLeaderboardText("t", entries, { rank: 4, score: 0 }, "روز", 99);
    expect(text).not.toContain("رتبه شما");
  });

  it("invites the first entrant when nobody qualifies yet", () => {
    const text = buildLeaderboardText("t", [], null, "روز", 99);
    expect(text).toContain("اولین نفر باش");
  });
});

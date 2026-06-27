import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  validateNickname,
  validateLetterBody,
  validateReplyBody,
  isReceivingDisabled,
  disableLockRemainingMs,
  isInboxVisible,
} from "../letters";

/** Format a Date as the SQLite `datetime('now')` shape ("YYYY-MM-DD HH:MM:SS", UTC). */
function sqliteUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

const DAY = 24 * 60 * 60 * 1000;

describe("validateNickname", () => {
  it("accepts a normal name", () => {
    const r = validateNickname("  ققنوس مهربون  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("ققنوس مهربون");
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateNickname("").ok).toBe(false);
    expect(validateNickname("   ").ok).toBe(false);
  });

  it("rejects over the max length", () => {
    expect(validateNickname("a".repeat(33)).ok).toBe(false);
    expect(validateNickname("a".repeat(32)).ok).toBe(true);
  });

  it("rejects @handles, links and t.me", () => {
    expect(validateNickname("hey @bob").ok).toBe(false);
    expect(validateNickname("see https://x.com").ok).toBe(false);
    expect(validateNickname("join t.me/foo").ok).toBe(false);
  });

  it("rejects phone numbers (7+ digit runs)", () => {
    expect(validateNickname("09123456789").ok).toBe(false);
    expect(validateNickname("سال ۱۴۰۳").ok).toBe(true); // short digit groups are fine
  });

  it("property: any value containing @word or a link is rejected", () => {
    const wordChar = fc.constantFrom("a", "z", "B", "0", "9", "_");
    fc.assert(
      fc.property(fc.string(), fc.string(), wordChar, (a, b, w) => {
        const withHandle = `${a}@${w}${b}`; // @ immediately followed by a word char
        const withLink = `${a}https://${b}`;
        expect(validateNickname(withHandle).ok).toBe(false);
        expect(validateNickname(withLink).ok).toBe(false);
      })
    );
  });
});

describe("validateLetterBody", () => {
  it("rejects below 100 chars, accepts at/above", () => {
    expect(validateLetterBody("a".repeat(99)).ok).toBe(false);
    expect(validateLetterBody("a".repeat(100)).ok).toBe(true);
  });

  it("rejects above 4096 chars", () => {
    expect(validateLetterBody("a".repeat(4096)).ok).toBe(true);
    expect(validateLetterBody("a".repeat(4097)).ok).toBe(false);
  });
});

describe("validateReplyBody", () => {
  it("allows short non-empty replies, rejects empty", () => {
    expect(validateReplyBody("ok").ok).toBe(true);
    expect(validateReplyBody("   ").ok).toBe(false);
  });

  it("rejects above 4096 chars", () => {
    expect(validateReplyBody("a".repeat(4097)).ok).toBe(false);
  });
});

describe("isReceivingDisabled / disableLockRemainingMs", () => {
  it("treats null as enabled with no lock", () => {
    const lu = { receiving_disabled_at: null };
    expect(isReceivingDisabled(lu)).toBe(false);
    expect(disableLockRemainingMs(lu, Date.now())).toBe(0);
  });

  it("returns >0 while inside the 7-day lock", () => {
    const now = Date.now();
    const lu = { receiving_disabled_at: sqliteUtc(new Date(now - 6 * DAY)) };
    expect(isReceivingDisabled(lu)).toBe(true);
    expect(disableLockRemainingMs(lu, now)).toBeGreaterThan(0);
  });

  it("returns <=0 once 7 days have passed", () => {
    const now = Date.now();
    const lu = { receiving_disabled_at: sqliteUtc(new Date(now - 7 * DAY - 1000)) };
    expect(disableLockRemainingMs(lu, now)).toBeLessThanOrEqual(0);
  });
});

describe("isInboxVisible", () => {
  const now = Date.now();

  it("hides anything already answered", () => {
    expect(
      isInboxVisible({ is_reply: 0, replied_at: sqliteUtc(new Date(now)), created_at: sqliteUtc(new Date(now)) }, now)
    ).toBe(false);
  });

  it("keeps unanswered original letters for 7 days only", () => {
    const fresh = { is_reply: 0, replied_at: null, created_at: sqliteUtc(new Date(now - 2 * DAY)) };
    const stale = { is_reply: 0, replied_at: null, created_at: sqliteUtc(new Date(now - 8 * DAY)) };
    expect(isInboxVisible(fresh, now)).toBe(true);
    expect(isInboxVisible(stale, now)).toBe(false);
  });

  it("keeps unanswered replies regardless of age", () => {
    const oldReply = { is_reply: 1, replied_at: null, created_at: sqliteUtc(new Date(now - 20 * DAY)) };
    expect(isInboxVisible(oldReply, now)).toBe(true);
  });
});

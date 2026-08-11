import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { validateDisplayName } from "../profile";
import { DISPLAY_NAME } from "../../config/constants";

describe("validateDisplayName", () => {
  it("accepts a normal name and trims it", () => {
    const r = validateDisplayName("  رضا  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("رضا");
  });

  it("collapses newlines and repeated spaces into single spaces", () => {
    const r = validateDisplayName("علی\n\n  رضایی");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("علی رضایی");
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateDisplayName("").ok).toBe(false);
    expect(validateDisplayName("   \n ").ok).toBe(false);
  });

  it("enforces the min and max length", () => {
    expect(validateDisplayName("ر").ok).toBe(false);
    expect(validateDisplayName("رض").ok).toBe(true);
    expect(validateDisplayName("a".repeat(DISPLAY_NAME.MAX)).ok).toBe(true);
    expect(validateDisplayName("a".repeat(DISPLAY_NAME.MAX + 1)).ok).toBe(false);
  });

  // The whole point of the rewrite: users used to copy "/setname اسم_جدید"
  // verbatim and end up actually named "اسم_جدید".
  it("rejects the instruction placeholder in its many shapes", () => {
    const variants = [
      "اسم_جدید",
      "اسم جدید",
      "اسم-جدید",
      "<اسم_جدید>",
      "«اسم جدید»",
      "  اسم   جدید  ",
      "نام_جدید",
      "نام جدید",
      "اسم جدیدت",
      "اسم نمایشی",
      "new name",
      "NewName",
      "SetName",
      // Arabic ي / ك spellings of the same words
      "اسم_جديد",
      "نام جديد",
    ];
    for (const v of variants) {
      expect(validateDisplayName(v).ok, v).toBe(false);
    }
  });

  it("still accepts real names that merely contain the word جدید", () => {
    expect(validateDisplayName("رضای جدید و خوشحال").ok).toBe(true);
    expect(validateDisplayName("جدیدی").ok).toBe(true);
  });

  it("rejects a command sent instead of a name", () => {
    expect(validateDisplayName("/setname").ok).toBe(false);
    expect(validateDisplayName("/start").ok).toBe(false);
  });

  it("requires at least one letter", () => {
    expect(validateDisplayName("۱۲۳").ok).toBe(false);
    expect(validateDisplayName("!!!").ok).toBe(false);
    expect(validateDisplayName("🔥🔥").ok).toBe(false);
    expect(validateDisplayName("رضا 🔥").ok).toBe(true);
  });

  it("rejects @handles, links and phone numbers", () => {
    expect(validateDisplayName("رضا @reza").ok).toBe(false);
    expect(validateDisplayName("https://x.com").ok).toBe(false);
    expect(validateDisplayName("t.me/foo").ok).toBe(false);
    expect(validateDisplayName("09123456789").ok).toBe(false);
    expect(validateDisplayName("رضا ۱۴۰۳").ok).toBe(true); // short digit groups are fine
  });

  it("property: an accepted value is trimmed, single-spaced and within limits", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = validateDisplayName(s);
        if (!r.ok) return;
        expect(r.value).toBe(r.value.trim());
        expect(r.value).not.toMatch(/\s\s|\n|\t/);
        expect(r.value.length).toBeGreaterThanOrEqual(DISPLAY_NAME.MIN);
        expect(r.value.length).toBeLessThanOrEqual(DISPLAY_NAME.MAX);
      })
    );
  });
});

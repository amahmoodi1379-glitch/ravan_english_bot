import { describe, it, expect } from "vitest";
// Importing keyboards registers the user-facing menu labels as a side effect.
import {
  MAIN_MENU_BUTTON_LETTERS,
  LETTERS_MENU_BUTTON_BACK,
  LETTERS_MENU_BUTTON_WRITE,
} from "../keyboards";
import { isUserMenuLabel, canonicalizeUserMenu } from "../premium-emojis";

describe("isUserMenuLabel", () => {
  it("recognises a full canonical label (emoji not stripped by the client)", () => {
    // Regression: a full label canonicalises to itself, so the old
    // `canonicalizeUserMenu(text) !== text` check missed it. isUserMenuLabel must not.
    expect(canonicalizeUserMenu(LETTERS_MENU_BUTTON_BACK)).toBe(LETTERS_MENU_BUTTON_BACK);
    expect(isUserMenuLabel(LETTERS_MENU_BUTTON_BACK)).toBe(true);
    expect(isUserMenuLabel(MAIN_MENU_BUTTON_LETTERS)).toBe(true);
    expect(isUserMenuLabel(LETTERS_MENU_BUTTON_WRITE)).toBe(true);
  });

  it("recognises an emoji-stripped label", () => {
    expect(isUserMenuLabel("بازگشت")).toBe(true);
  });

  it("returns false for ordinary message text", () => {
    expect(isUserMenuLabel("سلام، این یه نامه‌ی معمولیه")).toBe(false);
    expect(isUserMenuLabel("🔙 بازگشت به جای دیگه")).toBe(false);
  });
});

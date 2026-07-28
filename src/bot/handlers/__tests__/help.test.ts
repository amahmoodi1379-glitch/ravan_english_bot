import { describe, it, expect } from "vitest";
import {
  HELP_TOPICS,
  HELP_ACTION,
  buildHelpMenu,
  buildHelpTopicPage,
  helpTopicByKey,
} from "../help";
import { getMainMenuKeyboard, MAIN_MENU_BUTTON_HELP } from "../../keyboards";
import { CB_PREFIX } from "../../../config/constants";
import type { InlineKeyboardButton } from "../../types";

/** Flatten an inline keyboard into a single button list. */
function flatten(markup: { inline_keyboard: InlineKeyboardButton[][] }): InlineKeyboardButton[] {
  return markup.inline_keyboard.flat();
}

const BACK_CB = `${CB_PREFIX.HELP}:${HELP_ACTION.HOME}`;
const hasText = (btns: InlineKeyboardButton[], needle: string) =>
  btns.some((b) => b.text.includes(needle));

describe("help catalog", () => {
  it("has topics, each with at least one non-empty page and a unique key", () => {
    expect(HELP_TOPICS.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const t of HELP_TOPICS) {
      expect(t.key).toMatch(/^[a-z]+$/); // ASCII key → short, safe callback_data
      expect(keys.has(t.key)).toBe(false);
      keys.add(t.key);
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(t.pages.length).toBeGreaterThan(0);
      for (const page of t.pages) {
        expect(page.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every callback_data within Telegram's 64-byte limit", () => {
    const all: string[] = [];
    all.push(...flatten(buildHelpMenu().reply_markup).map((b) => b.callback_data!));
    for (const t of HELP_TOPICS) {
      for (let p = 0; p < t.pages.length; p++) {
        all.push(...flatten(buildHelpTopicPage(t.key, p)!.reply_markup).map((b) => b.callback_data!));
      }
    }
    for (const cb of all) {
      expect(cb).toBeTruthy();
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("buildHelpMenu (section list)", () => {
  it("renders exactly one button per topic, each opening page 0 of its topic", () => {
    const btns = flatten(buildHelpMenu().reply_markup);
    expect(btns.length).toBe(HELP_TOPICS.length);
    for (const t of HELP_TOPICS) {
      const btn = btns.find((b) => b.text === t.label);
      expect(btn, `button for ${t.key}`).toBeTruthy();
      expect(btn!.callback_data).toBe(`${CB_PREFIX.HELP}:${HELP_ACTION.TOPIC}:${t.key}:0`);
    }
  });

  it("styles every menu button either success or primary (matches the bot palette)", () => {
    for (const b of flatten(buildHelpMenu().reply_markup)) {
      expect(["success", "primary"]).toContain(b.style);
    }
  });

  it("packs at most two buttons per row", () => {
    for (const row of buildHelpMenu().reply_markup.inline_keyboard) {
      expect(row.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("buildHelpTopicPage (paging + back-button logic)", () => {
  it("returns null for an unknown topic key", () => {
    expect(buildHelpTopicPage("does-not-exist", 0)).toBeNull();
  });

  it("first page: no «صفحه قبل», always a «بازگشت به فهرست» button", () => {
    for (const t of HELP_TOPICS) {
      const btns = flatten(buildHelpTopicPage(t.key, 0)!.reply_markup);
      expect(hasText(btns, "صفحه قبل")).toBe(false);
      expect(btns.some((b) => b.callback_data === BACK_CB)).toBe(true);
      // A multi-page topic must offer a way forward from page 0.
      if (t.pages.length > 1) expect(hasText(btns, "صفحه بعد")).toBe(true);
    }
  });

  it("last page: no «صفحه بعد», but has «صفحه قبل» when multi-page", () => {
    for (const t of HELP_TOPICS) {
      const last = t.pages.length - 1;
      const btns = flatten(buildHelpTopicPage(t.key, last)!.reply_markup);
      expect(hasText(btns, "صفحه بعد")).toBe(false);
      expect(btns.some((b) => b.callback_data === BACK_CB)).toBe(true);
      if (t.pages.length > 1) expect(hasText(btns, "صفحه قبل")).toBe(true);
    }
  });

  it("middle pages carry BOTH «صفحه قبل» and «صفحه بعد»", () => {
    for (const t of HELP_TOPICS) {
      for (let p = 1; p < t.pages.length - 1; p++) {
        const btns = flatten(buildHelpTopicPage(t.key, p)!.reply_markup);
        expect(hasText(btns, "صفحه قبل")).toBe(true);
        expect(hasText(btns, "صفحه بعد")).toBe(true);
      }
    }
  });

  it("clamps an out-of-range page instead of throwing", () => {
    const t = HELP_TOPICS[0];
    const last = t.pages.length - 1;

    // Beyond the end → clamped to the last page (no next button).
    const high = flatten(buildHelpTopicPage(t.key, 999)!.reply_markup);
    expect(hasText(high, "صفحه بعد")).toBe(false);

    // Below zero → clamped to the first page (no prev button).
    const low = flatten(buildHelpTopicPage(t.key, -5)!.reply_markup);
    expect(hasText(low, "صفحه قبل")).toBe(false);

    // A non-integer/NaN page must not crash and lands on the first page.
    const nan = flatten(buildHelpTopicPage(t.key, Number.NaN)!.reply_markup);
    expect(hasText(nan, "صفحه قبل")).toBe(false);
    // Sanity: the same last page is reachable and shows the page counter.
    expect(buildHelpTopicPage(t.key, last)!.text).toContain("صفحه");
  });

  it("shows a page counter only for multi-page topics", () => {
    for (const t of HELP_TOPICS) {
      const view = buildHelpTopicPage(t.key, 0)!;
      if (t.pages.length > 1) {
        expect(view.text).toContain("صفحه");
      }
      // The topic title is always shown as the header.
      expect(view.text).toContain(t.title);
    }
  });

  it("back button points at the section-list home action", () => {
    const view = buildHelpTopicPage(HELP_TOPICS[0].key, 0)!;
    const back = flatten(view.reply_markup).find((b) => b.callback_data === BACK_CB);
    expect(back).toBeTruthy();
    expect(back!.text).toContain("بازگشت");
  });
});

describe("helpTopicByKey", () => {
  it("resolves known keys and rejects unknown ones", () => {
    expect(helpTopicByKey(HELP_TOPICS[0].key)).toBe(HELP_TOPICS[0]);
    expect(helpTopicByKey("nope")).toBeUndefined();
  });
});

describe("main-menu red guide button", () => {
  it("adds the guide as a full-width red (danger) row at the bottom", () => {
    const kb = getMainMenuKeyboard();
    const lastRow = kb.keyboard[kb.keyboard.length - 1];
    expect(lastRow).toHaveLength(1);
    expect(lastRow[0].text).toBe(MAIN_MENU_BUTTON_HELP);
    expect(lastRow[0].style).toBe("danger");
  });

  it("keeps the guide button out of the earlier feature rows", () => {
    const kb = getMainMenuKeyboard();
    const earlier = kb.keyboard.slice(0, -1).flat();
    expect(earlier.some((b) => b.text === MAIN_MENU_BUTTON_HELP)).toBe(false);
  });
});

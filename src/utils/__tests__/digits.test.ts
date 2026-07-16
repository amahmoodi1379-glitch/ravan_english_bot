import { describe, it, expect } from "vitest";
import { toEnglishDigits, toPersianDigits } from "../digits";

describe("toEnglishDigits", () => {
  it("converts Persian digits to ASCII", () => {
    expect(toEnglishDigits("۷۰۰")).toBe("700");
    expect(toEnglishDigits("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
  });

  it("converts Arabic-Indic digits to ASCII", () => {
    expect(toEnglishDigits("٧٠٠")).toBe("700");
  });

  it("leaves ASCII digits unchanged", () => {
    expect(toEnglishDigits("365")).toBe("365");
  });

  it("keeps non-digit characters intact", () => {
    expect(toEnglishDigits("۳۰ روز")).toBe("30 روز");
  });

  it("round-trips with toPersianDigits", () => {
    expect(toEnglishDigits(toPersianDigits(700))).toBe("700");
  });
});

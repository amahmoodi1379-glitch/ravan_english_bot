import { describe, it, expect } from "vitest";
import { formatAnswerStatsLine } from "../answer_stats";

describe("formatAnswerStatsLine", () => {
  it("shows an encouraging message below the threshold", () => {
    const line = formatAnswerStatsLine({ correct: 1, incorrect: 1, total: 2 });
    expect(line).toContain("اولین");
    expect(line).not.toContain("٪");
  });

  it("shows rounded percentages at/above the threshold", () => {
    const line = formatAnswerStatsLine({ correct: 9, incorrect: 3, total: 12 });
    // 9/12 = 75%
    expect(line).toContain("75٪ درست");
    expect(line).toContain("25٪ غلط");
    expect(line).toContain("12 پاسخ");
  });

  it("complements incorrect from correct so they sum to 100", () => {
    const line = formatAnswerStatsLine({ correct: 1, incorrect: 2, total: 3 }, 1);
    // 1/3 = 33% correct -> 67% incorrect
    expect(line).toContain("33٪ درست");
    expect(line).toContain("67٪ غلط");
  });
});

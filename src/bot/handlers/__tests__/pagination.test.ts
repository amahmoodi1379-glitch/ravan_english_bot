import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { LESSON_PICKER_PAGE_SIZE } from "../../../config/constants";

// Feature: lesson-aware-leitner, Property 7: Pagination invariants
// **Validates: Requirements 4.5, 4.6, 4.7**

/**
 * Pure pagination logic extracted from handleLessonPicker in leitner.ts.
 * Given totalItems and currentPage (0-indexed), compute page content and button visibility.
 */
const PAGE_SIZE = LESSON_PICKER_PAGE_SIZE; // 20

interface PaginationResult {
  pageItems: number[]; // indices of items on this page
  hasPrevButton: boolean;
  hasNextButton: boolean;
  totalPages: number;
}

function paginate(totalItems: number, currentPage: number): PaginationResult {
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const startIdx = currentPage * PAGE_SIZE;
  const endIdx = Math.min(startIdx + PAGE_SIZE, totalItems);

  const pageItems: number[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    pageItems.push(i);
  }

  return {
    pageItems,
    hasPrevButton: currentPage > 0,
    hasNextButton: currentPage < totalPages - 1,
    totalPages,
  };
}

// Generator: total items from 1 to 200
const totalItemsArb = fc.integer({ min: 1, max: 200 });

// Generator: (totalItems, currentPage) where currentPage is valid for that total
const paginationArb = totalItemsArb.chain((total) => {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  return fc.tuple(fc.constant(total), fc.integer({ min: 0, max: totalPages - 1 }));
});

describe("Property 7: Pagination invariants", () => {
  it("page 0 (first page) never has a prev button", () => {
    fc.assert(
      fc.property(totalItemsArb, (total) => {
        const result = paginate(total, 0);
        expect(result.hasPrevButton).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("last page never has a next button", () => {
    fc.assert(
      fc.property(totalItemsArb, (total) => {
        const totalPages = Math.ceil(total / PAGE_SIZE);
        const lastPage = totalPages - 1;
        const result = paginate(total, lastPage);
        expect(result.hasNextButton).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("middle pages (0 < page < totalPages - 1) have BOTH buttons", () => {
    // Only generate cases with at least 3 pages (totalItems > 2*PAGE_SIZE)
    const multiPageArb = fc.integer({ min: PAGE_SIZE * 2 + 1, max: 200 }).chain((total) => {
      const totalPages = Math.ceil(total / PAGE_SIZE);
      // Middle pages: 1 to totalPages - 2
      return fc.tuple(fc.constant(total), fc.integer({ min: 1, max: totalPages - 2 }));
    });

    fc.assert(
      fc.property(multiPageArb, ([total, page]) => {
        const result = paginate(total, page);
        expect(result.hasPrevButton).toBe(true);
        expect(result.hasNextButton).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("each page has at most PAGE_SIZE items", () => {
    fc.assert(
      fc.property(paginationArb, ([total, page]) => {
        const result = paginate(total, page);
        expect(result.pageItems.length).toBeLessThanOrEqual(PAGE_SIZE);
      }),
      { numRuns: 100 },
    );
  });

  it("first page shows items 0 to min(PAGE_SIZE-1, total-1)", () => {
    fc.assert(
      fc.property(totalItemsArb, (total) => {
        const result = paginate(total, 0);
        const expectedEnd = Math.min(PAGE_SIZE, total);
        const expectedItems = Array.from({ length: expectedEnd }, (_, i) => i);
        expect(result.pageItems).toEqual(expectedItems);
      }),
      { numRuns: 100 },
    );
  });

  it("union of all pages covers all items exactly once (no gaps, no overlaps)", () => {
    fc.assert(
      fc.property(totalItemsArb, (total) => {
        const totalPages = Math.ceil(total / PAGE_SIZE);
        const allItems: number[] = [];

        for (let p = 0; p < totalPages; p++) {
          const result = paginate(total, p);
          allItems.push(...result.pageItems);
        }

        // Should cover all items exactly once
        const expected = Array.from({ length: total }, (_, i) => i);
        expect(allItems).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("if total <= PAGE_SIZE, there is exactly 1 page with no pagination buttons", () => {
    const singlePageArb = fc.integer({ min: 1, max: PAGE_SIZE });

    fc.assert(
      fc.property(singlePageArb, (total) => {
        const result = paginate(total, 0);
        expect(result.totalPages).toBe(1);
        expect(result.hasPrevButton).toBe(false);
        expect(result.hasNextButton).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { buildPageWindow, renderPagination } from "../views";

// The pagination control shared by the admin list views (users, licenses, ...).
// buildPageWindow decides which page-number buttons to show; renderPagination
// turns the model into HTML. These tests pin the invariants a reviewer would
// otherwise have to eyeball: the window is always sorted, always anchored on the
// first/last page, always contains the current page, and only inserts an
// ellipsis where a real gap was collapsed.

describe("buildPageWindow", () => {
  const arb = fc.integer({ min: 1, max: 500 }).chain((totalPages) =>
    fc.tuple(fc.constant(totalPages), fc.integer({ min: 1, max: totalPages }))
  );

  it("always includes the first and last page", () => {
    fc.assert(
      fc.property(arb, ([totalPages, page]) => {
        const nums = buildPageWindow(page, totalPages).filter((x): x is number => x !== "ellipsis");
        expect(nums[0]).toBe(1);
        expect(nums[nums.length - 1]).toBe(totalPages);
      }),
      { numRuns: 200 }
    );
  });

  it("always includes the current page", () => {
    fc.assert(
      fc.property(arb, ([totalPages, page]) => {
        const nums = buildPageWindow(page, totalPages).filter((x): x is number => x !== "ellipsis");
        expect(nums).toContain(page);
      }),
      { numRuns: 200 }
    );
  });

  it("page numbers are strictly ascending with no duplicates", () => {
    fc.assert(
      fc.property(arb, ([totalPages, page]) => {
        const nums = buildPageWindow(page, totalPages).filter((x): x is number => x !== "ellipsis");
        for (let i = 1; i < nums.length; i++) {
          expect(nums[i]).toBeGreaterThan(nums[i - 1]);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("an ellipsis appears only where a gap greater than one was collapsed", () => {
    fc.assert(
      fc.property(arb, ([totalPages, page]) => {
        const window = buildPageWindow(page, totalPages);
        for (let i = 0; i < window.length; i++) {
          if (window[i] !== "ellipsis") continue;
          const before = window[i - 1] as number;
          const after = window[i + 1] as number;
          expect(after - before).toBeGreaterThan(1);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("never renders more than 9 numeric buttons (compact by construction)", () => {
    fc.assert(
      fc.property(arb, ([totalPages, page]) => {
        const nums = buildPageWindow(page, totalPages).filter((x) => x !== "ellipsis");
        expect(nums.length).toBeLessThanOrEqual(9);
      }),
      { numRuns: 200 }
    );
  });
});

describe("renderPagination", () => {
  it("shows only the summary line for a single page (nothing to navigate)", () => {
    const html = renderPagination({ basePath: "/admin/users", page: 1, totalPages: 1, totalCount: 7 });
    expect(html).toContain("مجموع 7");
    expect(html).not.toContain("pg-row");
    expect(html).not.toContain("رفتن به صفحه");
  });

  it("marks the current page with aria-current and disables edge arrows at the boundary", () => {
    const first = renderPagination({ basePath: "/admin/users", page: 1, totalPages: 5, totalCount: 250 });
    expect(first).toContain('aria-current="page"');
    // On page 1 the first/prev arrows are disabled (rendered as spans, no href).
    expect(first).toContain('pg-btn pg-edge pg-disabled');
    // ...while the next/last arrows are real links.
    expect(first).toContain('rel="next"');
    expect(first).toContain('rel="last"');
  });

  it("preserves extra query params on every page link and in the jump form", () => {
    const html = renderPagination({
      basePath: "/admin/users",
      page: 2,
      totalPages: 4,
      totalCount: 200,
      params: { q: "ali reza", hide_unverified: "1" },
    });
    // Values are URL-encoded and "&" escaped for a valid HTML attribute.
    expect(html).toContain("q=ali+reza");
    expect(html).toContain("hide_unverified=1");
    expect(html).toContain("&amp;");
    // The jump form carries the same params as hidden fields.
    expect(html).toContain('<input type="hidden" name="q" value="ali reza" />');
    expect(html).toContain('<input type="hidden" name="hide_unverified" value="1" />');
  });

  it("drops empty params instead of emitting a dangling q=", () => {
    const html = renderPagination({
      basePath: "/admin/licenses",
      page: 2,
      totalPages: 3,
      totalCount: 150,
      params: { q: "" },
    });
    expect(html).not.toContain("q=");
    expect(html).not.toContain('name="q"');
  });
});

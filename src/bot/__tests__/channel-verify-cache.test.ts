import { describe, it, expect } from "vitest";
import { isChannelVerificationFresh } from "../router";
import { CHANNEL_VERIFY_TTL_MS } from "../../config/constants";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");

describe("isChannelVerificationFresh (membership cache TTL)", () => {
  it("is fresh when verified just now", () => {
    expect(isChannelVerificationFresh(new Date(NOW).toISOString(), NOW)).toBe(true);
  });

  it("is fresh well within the TTL window", () => {
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    expect(isChannelVerificationFresh(oneHourAgo, NOW)).toBe(true);
  });

  it("is stale once the TTL has elapsed", () => {
    const past = new Date(NOW - CHANNEL_VERIFY_TTL_MS - 1).toISOString();
    expect(isChannelVerificationFresh(past, NOW)).toBe(false);
  });

  it("treats exactly-at-TTL as stale (boundary is exclusive)", () => {
    const exactlyTtl = new Date(NOW - CHANNEL_VERIFY_TTL_MS).toISOString();
    expect(isChannelVerificationFresh(exactlyTtl, NOW)).toBe(false);
  });

  it("treats null / undefined / empty as stale (forces a real check)", () => {
    expect(isChannelVerificationFresh(null, NOW)).toBe(false);
    expect(isChannelVerificationFresh(undefined, NOW)).toBe(false);
    expect(isChannelVerificationFresh("", NOW)).toBe(false);
  });

  it("treats an unparseable timestamp as stale rather than throwing", () => {
    expect(isChannelVerificationFresh("not-a-date", NOW)).toBe(false);
  });

  it("honours a custom TTL argument", () => {
    const tenMinAgo = new Date(NOW - 10 * 60 * 1000).toISOString();
    expect(isChannelVerificationFresh(tenMinAgo, NOW, 5 * 60 * 1000)).toBe(false);
    expect(isChannelVerificationFresh(tenMinAgo, NOW, 15 * 60 * 1000)).toBe(true);
  });
});

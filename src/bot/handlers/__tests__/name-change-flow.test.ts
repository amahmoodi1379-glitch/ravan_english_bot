import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Env } from "../../../types";
import { TelegramUpdate, TelegramCallbackQuery } from "../../types";
import { DbUser } from "../../../db/users";
import { CB_PREFIX } from "../../../config/constants";
import { PROFILE_MENU_BUTTON_STATS } from "../../keyboards";
import {
  handleProfileMessage,
  handleNameCallback,
  handleSetDisplayNameCommand,
} from "../profile";

/**
 * The display-name change flow: type the name → confirm → saved, with NO cap on
 * how many times it may happen. These tests drive the handlers through a fake D1
 * so the parts that actually bit users are pinned: nothing is written before the
 * user confirms, the old "/setname اسم_جدید" placeholder can never become someone's
 * name again, and a user who already renamed themselves many times can still rename.
 */

const TG_ID = 42;
const CHAT_ID = 900;

interface Fake {
  env: Env;
  state: Map<string, string>;
  saved: string[];
  sent: { text: string; body: Record<string, unknown> }[];
  user: DbUser;
}

function makeFake(nameChangeCount = 0): Fake {
  const state = new Map<string, string>();
  const saved: string[] = [];
  const sent: { text: string; body: Record<string, unknown> }[] = [];

  const user = {
    id: 7,
    telegram_id: TG_ID,
    username: "reza",
    first_name: "Reza",
    last_name: null,
    display_name: "اسم قدیمی",
    xp_total: 0,
    is_approved: 1,
    last_seen_at: null,
    is_banned: 0,
    banned_until: null,
    banned_by_admin_id: null,
    ban_reason: null,
    channel_verified_at: null,
  } as DbUser;

  const first = (sql: string, p: unknown[]) => {
    if (sql.includes("FROM admin_bot_state")) {
      const json = state.get(`${p[0]}:${p[1]}`);
      return json ? { state_json: json } : null;
    }
    if (sql.includes("FROM users") && sql.includes("telegram_id = ?")) {
      return p[0] === user.telegram_id ? user : null;
    }
    if (sql.includes("FROM users")) {
      // getUserProfile
      return {
        id: user.id,
        display_name: user.display_name,
        avatar_code: null,
        xp_total: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        last_seen_at: null,
        name_change_count: nameChangeCount,
        streak_count: 0,
        last_streak_date: null,
      };
    }
    return null;
  };

  const run = (sql: string, p: unknown[]) => {
    if (sql.includes("INSERT INTO admin_bot_state")) {
      state.set(`${p[0]}:${p[1]}`, String(p[2]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM admin_bot_state")) {
      if (sql.includes("scope <> ?")) {
        // Arming one text flow disarms the others: params are [tgId, ...scopes, keep].
        const keep = p[p.length - 1];
        for (const scope of p.slice(1, -1)) {
          if (scope !== keep) state.delete(`${p[0]}:${scope}`);
        }
      } else {
        state.delete(`${p[0]}:${p[1]}`);
      }
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE users") && sql.includes("display_name = ?")) {
      saved.push(String(p[0]));
      user.display_name = String(p[0]);
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  };

  const env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              first: async () => first(sql, params),
              all: async () => ({ results: [] }),
              run: async () => run(sql, params),
            };
          },
        };
      },
    },
  } as unknown as Env;

  return { env, state, saved, sent, user };
}

let fake: Fake;

beforeEach(() => {
  fake = makeFake();
  vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    if (typeof body.text === "string") fake.sent.push({ text: body.text, body });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a text-message update from the flow's user. */
function msg(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 1, from: { id: TG_ID }, chat: { id: CHAT_ID, type: "private" }, text },
  };
}

/** Build a callback query for one of the flow's inline buttons. */
function cb(prefix: string): TelegramCallbackQuery {
  return {
    id: "cb1",
    from: { id: TG_ID },
    data: `${prefix}:1`,
    message: { message_id: 2, chat: { id: CHAT_ID, type: "private" } },
  };
}

/** Put the user into the "type your new name" step. */
async function startFlow(f: Fake = fake) {
  await handleNameCallback(f.env, cb(CB_PREFIX.NAME_EDIT));
  f.sent.length = 0;
}

const lastText = (f: Fake = fake) => f.sent[f.sent.length - 1]?.text ?? "";

describe("display-name change flow", () => {
  it("ignores free text when the flow was never started", async () => {
    const handled = await handleProfileMessage(fake.env, fake.user, msg("رضا"));
    expect(handled).toBe(false);
    expect(fake.saved).toEqual([]);
  });

  it("asks for confirmation instead of saving straight away", async () => {
    await startFlow();

    const handled = await handleProfileMessage(fake.env, fake.user, msg("رضا رضایی"));

    expect(handled).toBe(true);
    expect(fake.saved).toEqual([]); // nothing written before the user confirms
    expect(lastText()).toContain("رضا رضایی");
    const markup = fake.sent[fake.sent.length - 1].body.reply_markup as {
      inline_keyboard: { callback_data?: string }[][];
    };
    const buttons = markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(buttons).toContain(`${CB_PREFIX.NAME_SAVE}:1`);
    expect(buttons).toContain(`${CB_PREFIX.NAME_CANCEL}:1`);
  });

  it("saves the name and clears the flow once confirmed", async () => {
    await startFlow();
    await handleProfileMessage(fake.env, fake.user, msg("  رضا   رضایی  "));

    await handleNameCallback(fake.env, cb(CB_PREFIX.NAME_SAVE));

    expect(fake.saved).toEqual(["رضا رضایی"]); // trimmed + single-spaced
    expect(fake.state.size).toBe(0);
    expect(lastText()).toContain("رضا رضایی");
  });

  it("lets the user retype to correct a typo without pressing anything", async () => {
    await startFlow();
    await handleProfileMessage(fake.env, fake.user, msg("رضاا"));
    await handleProfileMessage(fake.env, fake.user, msg("رضا"));

    await handleNameCallback(fake.env, cb(CB_PREFIX.NAME_SAVE));

    expect(fake.saved).toEqual(["رضا"]);
  });

  it("has no change limit — a user who renamed many times can rename again", async () => {
    const veteran = makeFake(99);
    fake = veteran; // route the fetch stub's captures to this fake
    await startFlow(veteran);
    await handleProfileMessage(veteran.env, veteran.user, msg("رضا"));
    await handleNameCallback(veteran.env, cb(CB_PREFIX.NAME_SAVE));

    expect(veteran.saved).toEqual(["رضا"]);
  });

  it("cancels without saving", async () => {
    await startFlow();
    await handleProfileMessage(fake.env, fake.user, msg("رضا"));

    await handleNameCallback(fake.env, cb(CB_PREFIX.NAME_CANCEL));

    expect(fake.saved).toEqual([]);
    expect(fake.state.size).toBe(0);
  });

  it("hands a menu-button tap back to the router and drops the flow", async () => {
    await startFlow();

    const handled = await handleProfileMessage(fake.env, fake.user, msg(PROFILE_MENU_BUTTON_STATS));

    expect(handled).toBe(false); // the router navigates instead
    expect(fake.state.size).toBe(0);
    expect(fake.saved).toEqual([]);
  });

  it("hands a command back to the router instead of naming the user '/start'", async () => {
    await startFlow();

    const handled = await handleProfileMessage(fake.env, fake.user, msg("/start"));

    expect(handled).toBe(false);
    expect(fake.saved).toEqual([]);
  });

  it("refuses the old placeholder and keeps asking", async () => {
    await startFlow();

    const handled = await handleProfileMessage(fake.env, fake.user, msg("اسم_جدید"));

    expect(handled).toBe(true);
    expect(fake.saved).toEqual([]);
    // Still in the flow, so a real name typed next is accepted.
    await handleProfileMessage(fake.env, fake.user, msg("رضا"));
    await handleNameCallback(fake.env, cb(CB_PREFIX.NAME_SAVE));
    expect(fake.saved).toEqual(["رضا"]);
  });

  it("saving an expired/empty pending name re-prompts instead of writing", async () => {
    await handleNameCallback(fake.env, cb(CB_PREFIX.NAME_SAVE));

    expect(fake.saved).toEqual([]);
    expect(lastText()).toContain("تغییر نام نمایشی");
  });

  it("arming the name flow disarms a leftover letters flow (and vice versa)", async () => {
    fake.state.set(`${TG_ID}:letters`, JSON.stringify({ action: "await_letter_body" }));

    await startFlow();

    expect([...fake.state.keys()]).toEqual([`${TG_ID}:profile`]);
  });

  describe("/setname shortcut", () => {
    it("'/setname رضا' goes to the confirm step, not a silent write", async () => {
      await handleSetDisplayNameCommand(fake.env, fake.user, CHAT_ID, "/setname رضا");

      expect(fake.saved).toEqual([]);
      expect(lastText()).toContain("رضا");

      await handleNameCallback(fake.env, cb(CB_PREFIX.NAME_SAVE));
      expect(fake.saved).toEqual(["رضا"]);
    });

    it("a bare '/setname' opens the guided flow", async () => {
      await handleSetDisplayNameCommand(fake.env, fake.user, CHAT_ID, "/setname");

      expect(lastText()).toContain("تغییر نام نمایشی");
      const handled = await handleProfileMessage(fake.env, fake.user, msg("رضا"));
      expect(handled).toBe(true);
    });

    it("'/setname اسم_جدید' never renames anyone to the placeholder", async () => {
      await handleSetDisplayNameCommand(fake.env, fake.user, CHAT_ID, "/setname اسم_جدید");

      expect(fake.saved).toEqual([]);
      expect(lastText()).toContain("اسم خودت رو بنویس");
    });
  });
});

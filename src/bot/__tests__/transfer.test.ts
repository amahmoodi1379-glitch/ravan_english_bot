import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Env } from "../../types";
import { TelegramUpdate } from "../types";
import {
  handleTransferUpdate,
  isTransferMode,
  resetTransferModeCache,
  TRANSFER_ANNOUNCEMENT,
  transferMessage,
  ZABANYAR_APK_URL,
  ZABANYAR_URL,
} from "../handlers/transfer";
import { renderTransferCard } from "../../admin/transfer-view";

// «حالت انتقال»: off unless an admin turns it on; when on, a learner gets only
// the move message with their own code, and admins keep the whole bot.

const ADMIN_TG = 900;
const LEARNER_TG = 501;
const NO_CODE_TG = 502;

function makeEnv(mode: "on" | "off" | null): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first() {
              if (sql.includes("system_settings")) return mode === null ? null : { value: mode };
              if (sql.includes("FROM admins")) return params[0] === ADMIN_TG ? { id: 1 } : null;
              if (sql.includes("access_codes")) return params[0] === LEARNER_TG ? { code: "Kx7<a&b>9" } : null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { DB, TELEGRAM_BOT_TOKEN: "t" } as unknown as Env;
}

const message = (tg: number, text = "سلام"): TelegramUpdate => ({
  update_id: 1,
  message: { message_id: 1, from: { id: tg, is_bot: false, first_name: "x" }, chat: { id: tg, type: "private" }, text } as never,
});

let calls: { method: string; body: Record<string, any> }[];

beforeEach(() => {
  resetTransferModeCache();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("transfer mode switch", () => {
  it("is off until an admin turns it on", async () => {
    expect(await isTransferMode(makeEnv(null))).toBe(false);
    resetTransferModeCache();
    expect(await isTransferMode(makeEnv("off"))).toBe(false);
    resetTransferModeCache();
    expect(await isTransferMode(makeEnv("on"))).toBe(true);
  });

  it("leaves the bot alone while off", async () => {
    expect(await handleTransferUpdate(makeEnv("off"), message(LEARNER_TG))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("while moving", () => {
  it("answers a learner with the move message, their own code and the two links, and nothing else runs", async () => {
    expect(await handleTransferUpdate(makeEnv("on"), message(LEARNER_TG))).toBe(true);
    expect(calls).toHaveLength(1);
    const { method, body } = calls[0]!;
    expect(method).toBe("sendMessage");
    expect(body.chat_id).toBe(LEARNER_TG);
    expect(body.text).toContain("<code>Kx7&lt;a&amp;b&gt;9</code>");
    expect(body.parse_mode).toBe("HTML");
    const urls = body.reply_markup.inline_keyboard.flat().map((b: { url: string }) => b.url);
    expect(urls).toEqual([ZABANYAR_URL, ZABANYAR_APK_URL]);
  });

  it("stops a button's spinner too", async () => {
    const update: TelegramUpdate = {
      update_id: 2,
      callback_query: { id: "cb1", from: { id: LEARNER_TG, is_bot: false, first_name: "x" } as never, data: "lt:x", message: { message_id: 3, chat: { id: LEARNER_TG, type: "private" } } as never },
    };
    expect(await handleTransferUpdate(makeEnv("on"), update)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
  });

  it("tells someone without a code where to get one", async () => {
    await handleTransferUpdate(makeEnv("on"), message(NO_CODE_TG));
    expect(calls[0]!.body.text).toContain("پشتیبانی");
    expect(calls[0]!.body.text).not.toContain("<code>");
  });

  it("lets admins use the whole bot", async () => {
    expect(await handleTransferUpdate(makeEnv("on"), message(ADMIN_TG))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("texts", () => {
  it("point to the app, mention the ten-day hold and never use «·»", () => {
    for (const text of [transferMessage("abc"), transferMessage(null), TRANSFER_ANNOUNCEMENT]) {
      expect(text).toContain("ravanenglish.ir");
      expect(text).toContain("۱۰ روز");
      expect(text).not.toContain("·");
    }
  });

  it("the panel card shows the state and offers the opposite switch", () => {
    expect(renderTransferCard(false)).toContain('name="mode" value="on"');
    expect(renderTransferCard(false)).toContain("خاموش");
    expect(renderTransferCard(true)).toContain('name="mode" value="off"');
    expect(renderTransferCard(true)).toContain("روشن");
  });
});

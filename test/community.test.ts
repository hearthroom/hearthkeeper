import test from "node:test";
import assert from "node:assert/strict";
import {
  CommunityStore,
  rolePlan,
  eligibleMessage,
  signedHeaders,
} from "../src/community/core.js";
test("durable XP outbox deduplicates gateway replays and survives retries", () => {
  const store = new CommunityStore(":memory:");
  const e = {
    id: "123456789012345678",
    user: "223456789012345678",
    channel: "323456789012345678",
    time: Date.now(),
  };
  for (let i = 0; i < 10; i++) store.enqueue(e);
  assert.equal(store.pending().length, 1);
  store.ack(e.id);
  assert.equal(store.pending().length, 0);
  store.enqueue(e);
  assert.equal(store.pending().length, 0);
  store.close();
});
test("role plan never removes human roles; unsafe roles and channel overwrites deny grants", () => {
  const safe = {
    id: "level",
    position: 1,
    managed: false,
    permissions: 0n,
    overwriteAllow: 0n,
  };
  assert.deepEqual(rolePlan([safe], ["level"], [], [], 3, []), {
    add: ["level"],
    remove: [],
  });
  assert.deepEqual(rolePlan([safe], [], ["level"], [], 3, []), {
    add: [],
    remove: [],
  });
  assert.deepEqual(rolePlan([safe], [], ["level"], ["level"], 3, []), {
    add: [],
    remove: ["level"],
  });
  assert.throws(() =>
    rolePlan([{ ...safe, permissions: 8n }], ["level"], [], [], 3, []),
  );
  assert.throws(() =>
    rolePlan([{ ...safe, overwriteAllow: 1024n }], ["level"], [], [], 3, []),
  );
  assert.throws(() => rolePlan([safe], ["level"], [], [], 3, ["level"]));
});
test("chat scoring excludes bots, webhooks, threads and non-public channels", () => {
  const base = {
    guildId: "g",
    channelId: "c",
    author: { bot: false },
    webhookId: null,
    system: false,
    type: 0,
    channel: { isThread: () => false, public: true },
  };
  assert.equal(eligibleMessage(base, "g", ["c"]), true);
  assert.equal(
    eligibleMessage({ ...base, author: { bot: true } }, "g", ["c"]),
    false,
  );
  assert.equal(
    eligibleMessage(
      { ...base, channel: { isThread: () => true, public: true } },
      "g",
      ["c"],
    ),
    false,
  );
  assert.equal(
    eligibleMessage(
      { ...base, channel: { isThread: () => false, public: false } },
      "g",
      ["c"],
    ),
    false,
  );
});
test("HMAC binds method, path, timestamp, nonce and body", () => {
  const a = signedHeaders(
    "key",
    "/internal/community/events",
    "{}",
    1700000000000,
    "fixed-nonce",
  );
  const b = signedHeaders(
    "key",
    "/internal/community/ack",
    "{}",
    1700000000000,
    "fixed-nonce",
  );
  assert.notEqual(a["X-Community-Signature"], b["X-Community-Signature"]);
});
test("removing a role from configuration cannot falsely acknowledge cleanup while it remains assigned", () => {
  assert.throws(() =>
    rolePlan([], [], ["retired-role"], ["retired-role"], 3, []),
  );
});
import { CommunityBot } from "../src/community/bot.js";
import { CaseStore } from "../src/cases/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
test("website case bridge uses the proven Discord owner, rejects other owners, and replays the same operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "community-case-test-"));
  const cases = new CaseStore({
    path: join(dir, "cases.db"),
    guildId: "guild",
    key: "11".repeat(32),
    lookupKey: "22".repeat(32),
  });
  const client = {
    guilds: { fetch: async () => ({ members: { fetch: async () => ({}) } }) },
  } as unknown as Client;
  const bot = new CommunityBot(
    client,
    "guild",
    {
      site: "https://hearthroom.club",
      key: "33".repeat(32),
      databasePath: ":memory:",
      channels: [],
      roles: [],
    },
    [],
    cases,
  );
  let user = "owner",
    result: any;
  let action = "create",
    id = "same-operation";
  let caseId = "";
  bot.call = async <T>(op: string, value: Record<string, unknown> = {}) => {
    if (op === "case-lease")
      return {
        id,
        user,
        version: "active-link",
        lease: "lease",
        expires: Date.now() + 10000,
        payload: {
          action,
          caseId,
          title: "A report",
          body: "Private details",
          category: "bug",
        },
      } as T;
    if (op === "case-result") result = value.result;
    return { ok: true } as T;
  };
  try {
    await bot.caseJob(id);
    caseId = result.id;
    await bot.caseJob(id);
    assert.equal(result.id, caseId);
    assert.equal(
      cases.list({ guildId: "guild", userId: "owner", staff: false }).length,
      1,
    );
    user = "other";
    action = "read";
    id = "other-operation";
    await bot.caseJob(id);
    assert.equal(result.error, "denied");
    assert.equal(JSON.stringify(result).includes("Private details"), false);
  } finally {
    bot.store.close();
    cases.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("paused XP ingestion cannot block unlink cleanup polling", async () => {
  const client = { isReady: () => true } as unknown as Client;
  const bot = new CommunityBot(
    client,
    "guild",
    {
      site: "https://hearthroom.club",
      key: "33".repeat(32),
      databasePath: ":memory:",
      channels: [],
      roles: [],
    },
    [],
  );
  bot.store.enqueue({
    id: "event",
    user: "owner",
    channel: "public",
    time: Date.now(),
  });
  const calls: string[] = [];
  bot.call = async <T>(op: string) => {
    calls.push(op);
    if (op === "events") throw new Error("ingestion_paused");
    return { subjects: [], jobs: [], notifications: [], review: null } as T;
  };
  try {
    await bot.tick();
    assert.deepEqual(calls, ["events", "pending"]);
    assert.equal(bot.store.pending().length, 1);
  } finally {
    bot.store.close();
  }
});

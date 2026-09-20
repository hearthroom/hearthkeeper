import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CaseStore } from "../src/cases/store.js";
import { PrivateDeliveryWorker } from "../src/cases/private-delivery.js";
const owner = { guildId: "g", userId: "reporter", staff: false };
const staff = { guildId: "g", userId: "staff", staff: true };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hk-private-"));
  let now = 1000000;
  const path = join(dir, "db");
  const options = {
    path,
    guildId: "g",
    key: "11".repeat(32),
    lookupKey: "22".repeat(32),
    now: () => now,
  };
  const store = new CaseStore(options);
  const create = (
    mode: "identified" | "anonymous" = "identified",
    direct = true,
  ) =>
    store.create(
      owner,
      {
        title: "Title",
        body: "Initial",
        mode,
        ...(direct ? { privateParentId: "parent" } : {}),
      },
      "create",
    );
  return {
    store,
    create,
    options,
    path,
    tick: (ms = 61000) => (now += ms),
    done() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function transport() {
  const sent: string[] = [];
  let creates = 0,
    syncVersion = 0;
  const t = {
    verify: async (_parent: string) => {},
    canCreate: async (_parent: string) => true,
    findThread: async (_p: any) => (creates ? "private-thread" : null),
    createThread: async (_p: any) => {
      creates++;
      return "private-thread";
    },
    findMessage: async (_p: any, key: string) =>
      sent.includes(key) ? key : null,
    sendEvent: async (_p: any, _c: any, e: any) => {
      sent.push(e.deliveryKey);
      return e.deliveryKey;
    },
    sync: async (_p: any, c: any) => {
      syncVersion = c.version;
    },
    remove: async (_parent: string, _thread: string) => {},
  };
  return {
    t,
    sent,
    get creates() {
      return creates;
    },
    get version() {
      return syncVersion;
    },
  };
}
test("private conversation is opt-in per identified case; anonymous and legacy cases never acquire one", () => {
  for (const mode of ["anonymous", "identified"] as const) {
    const f = fixture();
    try {
      if (mode === "anonymous") assert.throws(() => f.create(mode), /invalid/);
      const c = f.create(mode, false);
      assert.equal(f.store.privateProjection(c.id), undefined);
      assert.equal(f.store.read(owner, c.id).privateThreadId, undefined);
    } finally {
      f.done();
    }
  }
});
test("private outbox filters internal notes, keeps forum receipts independent and syncs close/reopen", async () => {
  const f = fixture(),
    t = transport();
  try {
    const c = f.create();
    f.store.thread(c.id, "staff-forum-thread");
    const w = new PrivateDeliveryWorker(f.store, t.t);
    await w.run();
    assert.equal(t.creates, 1);
    assert.equal(f.store.read(owner, c.id).privateThreadId, "private-thread");
    assert.equal(f.store.projection(c.id).events[0]?.status, "queued");
    f.store.act(staff, c.id, 1, "wait_technical", "STAFF ONLY", "internal");
    await w.run();
    assert.equal(t.sent.length, 1);
    f.store.act(staff, c.id, 2, "reply", "Public answer", "reply");
    f.store.act(staff, c.id, 3, "pass", "Fixed", "pass");
    await w.run();
    assert.equal(t.sent.length, 3);
    assert.equal(t.version, 4);
    f.store.act(staff, c.id, 4, "reopen", "Again", "reopen");
    await w.run();
    assert.equal(t.version, 5);
    assert.equal(t.creates, 1);
    assert.equal(f.store.projection(c.id).threadId, "staff-forum-thread");
  } finally {
    f.done();
  }
});
test("ambiguous create and send recover without duplicate private threads or posts", async () => {
  const f = fixture(),
    t = transport();
  try {
    const c = f.create();
    const create = t.t.createThread;
    t.t.createThread = async (p) => {
      await create(p);
      throw Error("timeout");
    };
    const w = new PrivateDeliveryWorker(f.store, t.t);
    await w.run();
    assert.equal(f.store.read(owner, c.id).privateThreadId, undefined);
    const send = t.t.sendEvent;
    t.t.sendEvent = async (p, c, e) => {
      await send(p, c, e);
      throw Error("timeout");
    };
    await w.run();
    t.t.sendEvent = send;
    await w.run();
    assert.equal(t.creates, 1);
    assert.equal(t.sent.length, 1);
    assert.equal(f.store.read(owner, c.id).privateThreadId, "private-thread");
  } finally {
    f.done();
  }
});
test("capacity and unsafe parent keep the report durable without starting ambiguous creation", async () => {
  const f = fixture(),
    t = transport();
  try {
    const c = f.create();
    t.t.canCreate = async () => false;
    const w = new PrivateDeliveryWorker(f.store, t.t);
    await w.run();
    assert.equal(t.creates, 0);
    assert.equal(f.store.privateProjection(c.id)?.status, "queued");
    t.t.canCreate = async () => true;
    t.t.verify = async () => {
      throw Error("unsafe");
    };
    await w.run();
    assert.equal(t.creates, 0);
    t.t.verify = async () => {};
    await w.run();
    assert.equal(t.creates, 1);
  } finally {
    f.done();
  }
});
test("both deletion targets survive restart; failed private deletion remains retryable", async () => {
  const f = fixture(),
    t = transport();
  try {
    const c = f.create();
    f.store.thread(c.id, "forum-thread");
    await new PrivateDeliveryWorker(f.store, t.t).run();
    f.store.act(staff, c.id, 1, "pass", "Fixed", "pass");
    f.tick(91 * 86400000);
    f.store.cleanup();
    assert.deepEqual(f.store.deletions(), ["forum-thread"]);
    assert.equal(f.store.privateDeletions()[0]?.threadId, "private-thread");
    const ledger = readFileSync(f.path + ".deletions.jsonl", "utf8")
      .trim()
      .split("\n");
    assert.equal(
      ledger.length,
      1,
      "all projections must enter one flushed receipt before any case deletion",
    );
    assert.equal(JSON.parse(ledger[0]!).targets.length, 2);
    t.t.remove = async () => {
      throw Error("transient");
    };
    const w = new PrivateDeliveryWorker(f.store, t.t);
    await w.run();
    assert.equal(f.store.privateDeletions().length, 1);
    t.t.remove = async () => {};
    await w.run();
    assert.equal(f.store.privateDeletions().length, 0);
    f.store.close();
    const reopened = new CaseStore(f.options);
    assert.equal(reopened.list(owner).length, 0);
    assert.equal(reopened.privateDeletions().length, 1);
    reopened.close();
  } finally {
    f.done();
  }
});
test("staff replies in the reporter conversation advance the same case without reading text or attachments", async () => {
  const { DiscordCases } = await import("../src/cases/discord.js");
  const f = fixture();
  try {
    const c = f.create();
    f.store.privateThread(c.id, "private-thread");
    let approved = true;
    const client: any = {
      guilds: {
        fetch: async () => ({
          id: "g",
          ownerId: "owner",
          members: {
            fetch: async () => ({
              id: "staff",
              roles: { cache: { has: () => approved } },
            }),
          },
        }),
      },
    };
    const cases = new DiscordCases(
      client,
      "g",
      "app",
      {
        forumId: "forum",
        staffRoleIds: ["staff"],
        key: "",
        lookupKey: "",
        databasePath: "unused",
      },
      f.store,
    );
    const m: any = {
      guildId: "g",
      id: "message",
      channelId: "private-thread",
      channel: { parentId: "parent" },
      author: { id: "staff", bot: false },
      type: 0,
      get content() {
        throw Error("must not read");
      },
      get attachments() {
        throw Error("must not read");
      },
    };
    approved = false;
    assert.equal(await cases.onStaffMessage(m), false);
    approved = true;
    assert.equal(await cases.onStaffMessage(m), true);
    assert.equal(f.store.read(owner, c.id).state, "in_progress");
    assert.equal(f.store.read(owner, c.id).events.length, 1);
  } finally {
    f.done();
  }
});

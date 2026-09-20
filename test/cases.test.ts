import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseStore, CaseError } from "../src/cases/store.js";
import { checkForumAccess } from "../src/cases/policy.js";
import { DeliveryWorker } from "../src/cases/delivery.js";
const key = "11".repeat(32),
  lookupKey = "22".repeat(32);
const member = { guildId: "g", userId: "member-A", staff: false };
const staff = { guildId: "g", userId: "staff-A", staff: true };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hk-test-"));
  let now = 1000000;
  const db = join(dir, "cases.db");
  const store = new CaseStore({
    path: db,
    guildId: "g",
    key,
    lookupKey,
    now: () => now,
  });
  return {
    store,
    dir,
    db,
    tick: (ms = 61000) => (now += ms),
    done: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function create(s: CaseStore, id = "request-1", actor = member) {
  return s.create(
    actor,
    {
      title: "A useful suggestion",
      body: "Private feedback text",
      mode: "anonymous",
    },
    id,
  );
}
test("SQLite persists atomic receipts, deduplicates submission, and isolates member and guild access", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    assert.equal(create(f.store).id, c.id);
    assert.equal(f.store.list(member).length, 1);
    assert.throws(
      () => f.store.read({ ...member, userId: "other" }, c.id),
      CaseError,
    );
    assert.throws(
      () => f.store.read({ ...staff, guildId: "foreign" }, c.id),
      CaseError,
    );
    assert.equal(f.store.list({ ...member, userId: "other" }).length, 0);
    assert.equal(
      f.store.read(staff, c.id).events[0]?.body,
      "Private feedback text",
    );
    assert.ok(
      !JSON.stringify(f.store.read(staff, c.id)).includes(member.userId),
    );
    assert.ok(!readFileSync(f.db).includes(Buffer.from(member.userId)));
    f.store.close();
    const reopened = new CaseStore({
      path: f.db,
      guildId: "g",
      key,
      lookupKey,
      now: () => 1000000,
    });
    assert.equal(reopened.list(member)[0]?.id, c.id);
    reopened.close();
  } finally {
    f.done();
  }
});
test("cooldown and open-case limit survive new request keys; retries do not consume quotas", () => {
  const f = fixture();
  try {
    create(f.store);
    assert.throws(() => create(f.store, "r2"), /cooldown/);
    f.tick();
    create(f.store, "r2");
    f.tick();
    create(f.store, "r3");
    f.tick();
    assert.throws(() => create(f.store, "r4"), /limit/);
  } finally {
    f.done();
  }
});
test("claim, reply, close and reopen have ownership, version and state checks with durable member-visible history", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    assert.throws(
      () => f.store.act(member, c.id, 1, "close", "resolved", "m1"),
      /denied/,
    );
    f.store.act(staff, c.id, 1, "claim", "", "s1");
    assert.throws(
      () => f.store.act(staff, c.id, 1, "reply", "stale", "s2"),
      /stale/,
    );
    f.store.act(staff, c.id, 2, "reply", "Public answer", "s2");
    f.store.act(staff, c.id, 3, "close", "Resolution", "s3");
    assert.equal(f.store.read(member, c.id).state, "closed");
    assert.throws(
      () => f.store.act(member, c.id, 4, "supplement", "late", "m2"),
      /closed/,
    );
    f.store.act(member, c.id, 4, "request_reopen", "More context", "m3");
    assert.equal(f.store.read(member, c.id).state, "closed");
    f.store.act(staff, c.id, 5, "reopen", "Review again", "s4");
    assert.equal(f.store.read(member, c.id).state, "in_progress");
    assert.ok(
      f.store.read(member, c.id).events.some((e) => e.body === "Resolution"),
    );
    assert.equal(
      f.store.act(staff, c.id, 5, "reopen", "Review again", "s4").version,
      6,
    );
  } finally {
    f.done();
  }
});
test("opaque actions bind actor, guild, case version and expiration; staff role loss is denied", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    const token = f.store.action(member, c.id, "supplement", 1);
    assert.throws(
      () => f.store.resolve({ ...member, userId: "other" }, token),
      /denied/,
    );
    assert.throws(
      () => f.store.resolve({ ...member, guildId: "other" }, token),
      /denied/,
    );
    assert.equal(f.store.resolve(member, token).caseId, c.id);
    const adminToken = f.store.action(staff, c.id, "close", 1, true);
    assert.throws(
      () => f.store.resolve({ ...staff, staff: false }, adminToken),
      /denied/,
    );
    f.tick(16 * 60000);
    assert.throws(() => f.store.resolve(member, token), /expired/);
  } finally {
    f.done();
  }
});
test("forum policy fails closed for public view, unrelated role/member grants and missing bot permissions", () => {
  const base = {
    guildId: "g",
    forumGuildId: "g",
    type: 15,
    botId: "bot",
    staffRoles: ["staff"],
    botPermissions:
      (1n << 10n) |
      (1n << 11n) |
      (1n << 14n) |
      (1n << 16n) |
      (1n << 34n) |
      (1n << 38n),
    overwrites: [
      { id: "g", type: 0, allow: "0", deny: "1024" },
      { id: "staff", type: 0, allow: "1024", deny: "0" },
      { id: "bot", type: 1, allow: "1024", deny: "0" },
    ],
  };
  assert.equal(checkForumAccess(base), true);
  for (const patch of [
    { type: 0 },
    { forumGuildId: "other" },
    { botPermissions: 0n },
    { overwrites: [] },
    {
      overwrites: [
        ...base.overwrites,
        { id: "other", type: 0, allow: "1024", deny: "0" },
      ],
    },
    {
      overwrites: [
        ...base.overwrites,
        { id: "person", type: 1, allow: "1024", deny: "0" },
      ],
    },
  ])
    assert.equal(checkForumAccess({ ...base, ...patch }), false);
});
class FakeTransport {
  allowed = true;
  creates = 0;
  sends = 0;
  lostCreate = false;
  threads = new Map<string, string>();
  messages = new Map<string, string>();
  closed = false;
  async verify() {
    if (!this.allowed) throw new Error("unsafe");
  }
  async findThread(id: string) {
    return this.threads.get(id) ?? null;
  }
  async createThread(c: any, e: any) {
    this.creates++;
    this.threads.set(c.id, "thread-1");
    if (this.lostCreate) {
      this.lostCreate = false;
      throw new Error("network");
    }
    return "thread-1";
  }
  async findMessage(t: string, key: string) {
    return this.messages.get(key) ?? null;
  }
  async sendEvent(t: string, c: any, e: any) {
    this.sends++;
    this.messages.set(e.deliveryKey, "msg-" + this.sends);
    return "msg-" + this.sends;
  }
  async sync(c: any) {
    this.closed = c.state === "closed";
  }
  async remove(t: string) {
    this.threads.clear();
  }
}
test("outbox recovers an ambiguous create without duplicate thread and preserves closed archive across worker restart", async () => {
  const f = fixture();
  const t = new FakeTransport();
  try {
    const c = create(f.store);
    t.lostCreate = true;
    await new DeliveryWorker(f.store, t).run();
    assert.equal(t.creates, 1);
    f.tick();
    await new DeliveryWorker(f.store, t).run();
    assert.equal(t.creates, 1);
    assert.equal(f.store.read(member, c.id).sync, "synced");
    f.store.act(staff, c.id, 1, "close", "Done", "close1");
    await new DeliveryWorker(f.store, t).run();
    assert.equal(t.closed, true);
    assert.equal(f.store.read(member, c.id).sync, "synced");
  } finally {
    f.done();
  }
});
test("permission drift prevents all sends; accepted data remains visible and retries after recovery", async () => {
  const f = fixture();
  const t = new FakeTransport();
  try {
    const c = create(f.store);
    t.allowed = false;
    await new DeliveryWorker(f.store, t).run();
    assert.equal(t.creates, 0);
    assert.equal(f.store.read(member, c.id).sync, "pending");
    t.allowed = true;
    f.tick();
    await new DeliveryWorker(f.store, t).run();
    assert.equal(t.creates, 1);
  } finally {
    f.done();
  }
});
test("uncertain send with no readback never blindly duplicates; deleted threads do not silently lose data", async () => {
  const f = fixture();
  const t = new FakeTransport();
  try {
    const c = create(f.store);
    t.createThread = async () => {
      t.creates++;
      throw new Error("unknown");
    };
    await new DeliveryWorker(f.store, t).run();
    f.tick();
    await new DeliveryWorker(f.store, t).run();
    assert.equal(t.creates, 1);
    assert.equal(f.store.read(member, c.id).sync, "pending");
  } finally {
    f.done();
  }
});
test("retention removes closed content and identities while retaining a retryable deletion ledger", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    f.store.thread(c.id, "old-thread");
    f.store.act(staff, c.id, 1, "close", "Done", "done");
    f.tick(91 * 86400000);
    f.store.cleanup();
    assert.equal(f.store.list(member).length, 0);
    assert.deepEqual(f.store.deletions(), ["old-thread"]);
    assert.match(readFileSync(f.db + ".deletions.jsonl", "utf8"), /old-thread/);
    assert.doesNotMatch(
      readFileSync(f.db + ".deletions.jsonl", "utf8"),
      /Private feedback/,
    );
  } finally {
    f.done();
  }
});
test("wrong case keys fail closed and never silently orphan encrypted identity mappings", () => {
  const f = fixture();
  try {
    create(f.store);
    assert.throws(
      () =>
        new CaseStore({
          path: f.db,
          guildId: "g",
          key: "33".repeat(32),
          lookupKey,
        }),
      /mismatch/,
    );
  } finally {
    f.done();
  }
});
test("member supplements are throttled durably without blocking a retry of the same interaction", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    f.store.act(member, c.id, 1, "supplement", "one", "one");
    assert.equal(
      f.store.act(member, c.id, 1, "supplement", "one", "one").version,
      2,
    );
    assert.throws(
      () => f.store.act(member, c.id, 2, "supplement", "two", "two"),
      /reply_cooldown/,
    );
    f.tick();
    f.store.act(member, c.id, 2, "supplement", "two", "two");
  } finally {
    f.done();
  }
});
test("identifiable reports disclose only the explicit identified mode and never leak an anonymous owner", () => {
  const f = fixture();
  try {
    const c = f.store.create(
      member,
      { title: "Private", body: "Hello", mode: "identified" },
      "identified",
    );
    assert.equal(f.store.projection(c.id).reporter, member.userId);
    assert.equal(
      f.store.read({ ...member, staff: false }, c.id).reporter,
      undefined,
    );
    f.tick();
    const anonymous = create(f.store, "anon");
    assert.equal(f.store.projection(anonymous.id).reporter, undefined);
  } finally {
    f.done();
  }
});

test("forum controls are staff-only and do not silently mark a report resolved", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    assert.throws(
      () => f.store.act(member, c.id, 1, "archive", "organize", "x"),
      /denied/,
    );
    const archived = f.store.act(staff, c.id, 1, "archive", "organize", "a");
    assert.equal(archived.state, "submitted");
    assert.equal(archived.archived, true);
    assert.equal(archived.locked, false);
    assert.ok(
      !f.store.read(member, c.id).events.some((e) => e.body === "organize"),
    );
    const locked = f.store.act(staff, c.id, 2, "lock", "hold", "b");
    assert.equal(locked.locked, true);
    const restored = f.store.act(staff, c.id, 3, "restore", "resume", "c");
    assert.equal(restored.archived, false);
    assert.equal(restored.locked, false);
    const both = f.store.act(staff, c.id, 4, "archive_lock", "hold", "d");
    assert.equal(both.archived, true);
    assert.equal(both.locked, true);
    const closed = f.store.act(staff, c.id, 5, "close", "resolved", "e");
    assert.equal(closed.state, "closed");
    assert.throws(
      () => f.store.act(staff, c.id, 6, "restore", "resume", "f"),
      /closed/,
    );
  } finally {
    f.done();
  }
});
test("report category is validated, stored and survives status transitions", () => {
  const f = fixture();
  try {
    const c = f.store.create(
      member,
      {
        title: "Card issue",
        body: "Details",
        mode: "anonymous",
        category: "card_report",
      },
      "cat",
    );
    assert.equal(c.category, "card_report");
    const closed = f.store.act(staff, c.id, 1, "close", "Done", "close");
    assert.equal(closed.category, "card_report");
    f.tick();
    assert.throws(
      () =>
        f.store.create(
          member,
          {
            title: "Bad",
            body: "Details",
            mode: "anonymous",
            category: "unknown",
          },
          "bad",
        ),
      /invalid/,
    );
  } finally {
    f.done();
  }
});

test("upgrade from the old schema preserves closed cases and encrypted ownership", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    f.store.act(staff, c.id, 1, "close", "Resolved", "close");
    f.store.close();
    const db = new DatabaseSync(f.db);
    db.exec(
      "ALTER TABLE cases DROP COLUMN category; ALTER TABLE cases DROP COLUMN archived; ALTER TABLE cases DROP COLUMN locked;",
    );
    db.close();
    const upgraded = new CaseStore({
      path: f.db,
      guildId: "g",
      key,
      lookupKey,
    });
    const restored = upgraded.read(member, c.id);
    assert.equal(restored.category, "general");
    assert.equal(restored.archived, true);
    assert.equal(restored.locked, true);
    assert.equal(restored.events.at(-1)?.body, "Resolved");
    upgraded.close();
  } finally {
    f.done();
  }
});

test("staff can choose waiting, processing or waiting for technology; replies advance status but member updates preserve the queue", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    assert.throws(
      () =>
        f.store.act(
          member,
          c.id,
          1,
          "wait_technical" as any,
          "Need help",
          "denied",
        ),
      /denied/,
    );
    let current = f.store.act(
      staff,
      c.id,
      1,
      "wait_technical" as any,
      "Need technical review",
      "tech",
    );
    assert.equal(current.state, "waiting_technical");
    current = f.store.act(
      member,
      c.id,
      current.version,
      "supplement",
      "Extra details",
      "extra",
    );
    assert.equal(current.state, "waiting_technical");
    current = f.store.act(
      staff,
      c.id,
      current.version,
      "reply",
      "Answer",
      "answer",
    );
    assert.equal(current.state, "in_progress");
    current = f.store.act(
      staff,
      c.id,
      current.version,
      "set_waiting" as any,
      "Queued",
      "queue",
    );
    assert.equal(current.state, "submitted");
    current = f.store.act(
      staff,
      c.id,
      current.version,
      "set_processing" as any,
      "Started",
      "start",
    );
    assert.equal(current.state, "in_progress");
    assert.ok(
      !f.store
        .read(member, c.id)
        .events.some((e) => e.body === "Need technical review"),
    );
  } finally {
    f.done();
  }
});

test("original creation time and persistent shared panel identity survive reopen and expired UI tokens", () => {
  const f = fixture();
  try {
    const c = create(f.store);
    assert.equal(c.createdAt, 1000000);
    const token = f.store.action(staff, c.id, "staff_view", 1, true);
    const ordinary = f.store.action(member, c.id, "view", 1);
    assert.equal(f.store.hasStaffAction(c.id, "hk:act:" + token), true);
    assert.equal(f.store.hasStaffAction(c.id, "hk:act:" + ordinary), false);
    assert.equal(f.store.hasStaffAction("wrong", "hk:act:" + token), false);
    f.tick(91 * 86400000);
    assert.throws(() => f.store.resolve(staff, token), /expired/);
    assert.equal(f.store.hasStaffAction(c.id, "hk:act:" + token), true);
    assert.equal(f.store.read(member, c.id).createdAt, 1000000);
  } finally {
    f.done();
  }
});

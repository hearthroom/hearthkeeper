import test from "node:test";
import assert from "node:assert/strict";
import { DiscordCases } from "../src/cases/discord.js";
import { categories } from "../src/cases/catalog.js";
function fixture() {
  const tags = [
    ...categories.map((c) => c.zh),
    "🔵 等待中",
    "⚪ 處理中",
    "🟠 等待中（技術）",
    "待補充",
    "已結案",
  ].map((name, i) => ({ name, id: String(i + 1) }));
  const thread: any = {
    id: "thread",
    parentId: "forum",
    guildId: "g",
    ownerId: "app",
    locked: false,
    archived: false,
    appliedTags: [],
    isThread: () => true,
    edit: async (p: any) => Object.assign(thread, p),
    fetchStarterMessage: async () => ({
      author: { id: "app" },
      edit: async () => {},
    }),
  };
  let created: any;
  const forum: any = {
    id: "forum",
    type: 15,
    guildId: "g",
    availableTags: tags,
    threads: {
      create: async (p: any) => {
        created = p;
        return thread;
      },
    },
  };
  const client: any = {
    channels: {
      fetch: async (id: string) => (id === "forum" ? forum : thread),
    },
  };
  const transport = new DiscordCases(
    client,
    "g",
    "app",
    {
      forumId: "forum",
      staffRoleIds: ["staff"],
      databasePath: "unused",
      key: "",
      lookupKey: "",
    },
    { action: () => "opaque" } as any,
  );
  const c: any = {
    id: "case",
    version: 1,
    title: "Test",
    category: "billing",
    state: "submitted",
    mode: "anonymous",
    archived: false,
    locked: false,
    threadId: "thread",
  };
  return {
    transport,
    c,
    thread,
    forum,
    get created() {
      return created;
    },
  };
}
test("Discord posts retain category and replace lifecycle tag, with independent archive and lock readback", async () => {
  const f = fixture();
  await f.transport.createThread(f.c, {
    kind: "submitted",
    body: "test",
    seq: 1,
    deliveryKey: "key",
  } as any);
  assert.deepEqual(f.created.appliedTags, ["2", "7"]);
  assert.deepEqual(f.created.message.allowedMentions.roles, ["staff"]);
  assert.equal(f.created.message.content, "<@&staff>");
  await f.transport.sync({
    ...f.c,
    state: "waiting_member",
    archived: true,
    locked: false,
  });
  assert.deepEqual(f.thread.appliedTags, ["2", "10"]);
  assert.equal(f.thread.archived, true);
  assert.equal(f.thread.locked, false);
  await f.transport.sync({ ...f.c, state: "waiting_technical" });
  assert.deepEqual(f.thread.appliedTags, ["2", "9"]);
  await f.transport.sync({
    ...f.c,
    state: "closed",
    archived: true,
    locked: true,
  });
  assert.deepEqual(f.thread.appliedTags, ["2", "11"]);
  assert.equal(f.thread.locked, true);
  await f.transport.sync({
    ...f.c,
    state: "in_progress",
    archived: false,
    locked: false,
  });
  assert.deepEqual(f.thread.appliedTags, ["2", "8"]);
  assert.equal(f.thread.archived, false);
  assert.equal(f.thread.locked, false);
});
test("missing configured tags prevent creating an unclassified post", async () => {
  const f = fixture();
  f.forum.availableTags = [];
  await assert.rejects(
    () =>
      f.transport.createThread(f.c, {
        kind: "submitted",
        body: "test",
        seq: 1,
        deliveryKey: "key",
      } as any),
    /tags_missing/,
  );
  assert.equal(f.created, undefined);
});

test("approved staff replies change a tracked case without reading content; foreign, bot, unknown and closed cases are ignored", async () => {
  const { CaseStore } = await import("../src/cases/store.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hk-staff-message-"));
  const store = new CaseStore({
    path: join(dir, "db"),
    guildId: "g",
    key: "11".repeat(32),
    lookupKey: "22".repeat(32),
  });
  let authorized = true;
  const guild = {
    id: "g",
    ownerId: "owner",
    members: {
      fetch: async () => ({
        id: "staff-member",
        roles: { cache: { has: () => authorized } },
      }),
    },
  };
  const client: any = { guilds: { fetch: async () => guild } };
  const transport = new DiscordCases(
    client,
    "g",
    "app",
    {
      forumId: "forum",
      staffRoleIds: ["staff"],
      databasePath: "unused",
      key: "",
      lookupKey: "",
    },
    store,
  );
  const actor = { guildId: "g", userId: "staff-member", staff: true };
  try {
    const c = store.create(
      { guildId: "g", userId: "reporter", staff: false },
      { title: "Synthetic", body: "Report", mode: "anonymous" },
      "create",
    );
    store.thread(c.id, "thread");
    const message: any = {
      id: "message",
      guildId: "g",
      channelId: "thread",
      channel: { parentId: "forum" },
      type: 0,
      author: { id: "staff-member", bot: false },
      get content() {
        throw Error("content must not be read");
      },
      get attachments() {
        throw Error("attachments must not be read");
      },
    };
    for (const patch of [
      { guildId: "other" },
      { author: { id: "bot", bot: true } },
      { channelId: "unknown" },
      { channel: { parentId: "other" } },
      { webhookId: "webhook" },
    ])
      assert.equal(
        await transport.onStaffMessage({
          ...messageWithoutBody(message),
          ...patch,
        }),
        false,
      );
    authorized = false;
    assert.equal(await transport.onStaffMessage(message), false);
    authorized = true;
    assert.equal(await transport.onStaffMessage(message), true);
    assert.equal(store.read(actor, c.id).state, "in_progress");
    assert.equal(await transport.onStaffMessage(message), false);
    const current = store.read(actor, c.id);
    store.act(actor, c.id, current.version, "close", "Resolved", "close");
    assert.equal(
      await transport.onStaffMessage({
        ...messageWithoutBody(message),
        id: "late",
      }),
      false,
    );
    assert.equal(store.read(actor, c.id).state, "closed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function messageWithoutBody(m: any) {
  return {
    id: m.id,
    guildId: m.guildId,
    channelId: m.channelId,
    channel: m.channel,
    type: m.type,
    author: m.author,
  };
}

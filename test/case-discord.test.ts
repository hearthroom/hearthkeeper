import test from "node:test";
import assert from "node:assert/strict";
import { DiscordCases } from "../src/cases/discord.js";
import { categories } from "../src/cases/catalog.js";
function fixture() {
  const tags = [
    ...categories.map((c) => c.zh),
    "等待中",
    "處理中",
    "等待中（技術）",
    "待補充",
    "已結案",
    "暫停處理",
    "討論中",
    "PASS",
    "未採納",
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
      content: "",
      embeds: [],
      edit: async (p: any) => {
        edited = p;
      },
    }),
  };
  let created: any;
  let edited: any;
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
    createdAt: Date.parse("2026-09-20T07:54:00Z"),
    events: [{ seq: 1, kind: "submitted", body: "test", deliveryKey: "key" }],
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
    get edited() {
      return edited;
    },
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
  assert.ok(f.created.message.content.endsWith("<@&staff>"));
  assert.equal(f.created.message.flags, 4);
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

test("forum titles use submitted titles and the first post starts with its original date and content", async () => {
  const f = fixture();
  await f.transport.createThread(f.c, f.c.events[0]);
  assert.equal(f.created.name, "Test");
  assert.equal(
    f.created.message.content,
    "2026-09-20 15:54（UTC+8）｜test\n\n<@&staff>",
  );
  f.thread.name = "HK-case";
  await f.transport.sync({ ...f.c, archived: true, locked: true });
  assert.equal(f.thread.name, "Test");
  assert.equal(
    f.edited.content,
    "2026-09-20 15:54（UTC+8）｜test\n\n<@&staff>",
  );
  assert.equal(f.thread.archived, true);
  assert.equal(f.thread.locked, true);
});
test("ambiguous creation recovery uses stored staff controls, not equal titles, and still recognizes legacy titles", async () => {
  const { Collection } = await import("discord.js");
  const f = fixture();
  const make = (id: string, name: string, code: string, ownerId = "app") => ({
    id,
    name,
    ownerId,
    parentId: "forum",
    fetchStarterMessage: async () => ({
      author: { id: ownerId },
      components: [{ components: [{ customId: "hk:act:" + code }] }],
    }),
  });
  const wrong = make("wrong", "HK-case", "wrong");
  const correct = make("correct", "Test", "expected");
  (f.transport as any).store = {
    hasStaffAction: (id: string, code: string) =>
      id === "case" && code === "hk:act:expected",
  };
  f.forum.threads.fetchActive = async () => ({
    threads: new Collection([
      ["wrong", wrong],
      ["foreign", make("foreign", "HK-case", "expected", "other")],
    ]),
  });
  f.forum.threads.fetchArchived = async () => ({
    threads: new Collection([["correct", correct]]),
    hasMore: false,
  });
  assert.equal(await f.transport.findThread("case"), "correct");
  f.forum.threads.fetchActive = async () => ({
    threads: new Collection([["old", make("old", "HK-case", "expected")]]),
  });
  assert.equal(await f.transport.findThread("case"), "old");
});

test("plain starter preserves the longest accepted body without truncation or automatic link previews", async () => {
  const f = fixture();
  const body = "*".repeat(1350) + "https://example.test @everyone END";
  await f.transport.createThread(f.c, { ...f.c.events[0], body });
  assert.ok(f.created.message.content.includes(body));
  assert.ok(f.created.message.content.length <= 2000);
  assert.equal(f.created.message.flags, 4);
  assert.deepEqual(f.created.message.allowedMentions, {
    parse: [],
    roles: ["staff"],
  });
});

test("external thread changes use fresh state and ignore pending bot writes, foreign and untracked threads", async () => {
  const f = fixture();
  let pending = false;
  let observed: any;
  let reads = 0;
  const c = { ...f.c, sync: "synced" };
  (f.transport as any).store = {
    caseForThread: (id: string) => (id === "thread" ? "case" : undefined),
    projection: () => ({ ...c, sync: pending ? "pending" : "synced" }),
    observeThread: (_id: string, _v: number, flags: any) => {
      observed = flags;
      return true;
    },
  };
  (f.transport as any).client.channels.fetch = async () => {
    reads++;
    return f.thread;
  };
  const event = {
    id: "thread",
    guildId: "g",
    parentId: "forum",
    locked: true,
    archived: true,
  };
  assert.equal(
    await f.transport.onThreadUpdate({ ...event, guildId: "other" }),
    false,
  );
  assert.equal(
    await f.transport.onThreadUpdate({ ...event, id: "unknown" }),
    false,
  );
  pending = true;
  assert.equal(await f.transport.onThreadUpdate(event), false);
  assert.equal(reads, 0);
  pending = false;
  assert.equal(await f.transport.onThreadUpdate(event), true);
  assert.deepEqual(observed, { locked: false, archived: false });
});

test("preflight requires each uploaded emoji and matching forum tag before exposing controls", async () => {
  const { Collection } = await import("discord.js");
  const { statusEmojiNames, statusLabels } = await import(
    "../src/cases/catalog.js"
  );
  const { requiredBotPermissions } = await import("../src/cases/policy.js");
  const f = fixture();
  const emojis = new Collection(
    Object.entries(statusEmojiNames).map(([state, name], n) => {
      const id = String(100 + n);
      f.forum.availableTags.find(
        (t: any) => t.name === statusLabels[state],
      ).emoji = { id };
      return [
        id,
        {
          id,
          name,
          available: true,
          animated: false,
          roles: { cache: new Collection() },
        },
      ] as const;
    }),
  );
  f.forum.guild = {
    roles: { fetch: async () => {}, cache: new Collection() },
    members: {
      fetchMe: async () => ({ id: "app", roles: { cache: new Collection() } }),
    },
    emojis: { fetch: async () => emojis },
  };
  f.forum.permissionsFor = () => ({
    has: () => true,
    bitfield: requiredBotPermissions,
  });
  f.forum.permissionOverwrites = {
    cache: new Collection([
      [
        "g",
        {
          id: "g",
          type: 0,
          allow: { bitfield: 0n },
          deny: { bitfield: 1024n },
        },
      ],
    ]),
  };
  await f.transport.verify();
  const waiting = f.forum.availableTags.find((t: any) => t.name === "等待中");
  waiting.emoji = { id: "wrong" };
  await assert.rejects(() => f.transport.verify(), /status_tag_emoji_mismatch/);
  waiting.emoji = { id: "100" };
  (emojis.get("100")! as { available: boolean }).available = false;
  await assert.rejects(() => f.transport.verify(), /status_emoji_unavailable/);
});

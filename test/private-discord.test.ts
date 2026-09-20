import test from "node:test";
import assert from "node:assert/strict";
import {
  Collection,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import {
  DiscordPrivateCases,
  checkPrivateParentAccess,
} from "../src/cases/private-discord.js";
const memberAllow =
  P.ViewChannel |
  P.SendMessagesInThreads |
  P.AttachFiles |
  P.ReadMessageHistory;
const memberDeny =
  P.SendMessages |
  P.CreatePublicThreads |
  P.CreatePrivateThreads |
  P.ManageThreads;
function fixture() {
  const everyone = {
    id: "g",
    type: 0,
    allow: new PermissionsBitField(memberAllow),
    deny: new PermissionsBitField(memberDeny),
  };
  const staff = { id: "staff" };
  const me = { id: "app" };
  let sent: any;
  const added: string[] = [];
  const thread: any = {
    id: "thread",
    parentId: "parent",
    guildId: "g",
    type: 12,
    ownerId: "app",
    name: "temporary",
    invitable: false,
    archived: false,
    locked: false,
    edit: async (v: any) => {
      Object.assign(thread, v);
      return thread;
    },
    members: {
      add: async (id: string) => {
        added.push(id);
      },
      fetch: async (v: any) => {
        if (!added.includes(v.member)) throw Error("not_member");
        return { id: v.member };
      },
    },
    send: async (v: any) => {
      sent = v;
      return { id: "message" };
    },
    messages: {
      fetch: async (v: any) =>
        typeof v === "string"
          ? { author: { id: "app" }, edit: async () => {} }
          : new Collection(),
    },
    delete: async () => {
      thread.deleted = true;
    },
  };
  const parent: any = {
    id: "parent",
    type: 0,
    guildId: "g",
    permissionOverwrites: { cache: new Collection([["g", everyone]]) },
    permissionsFor: (who: any) =>
      new PermissionsBitField(
        who.id === "reporter"
          ? memberAllow
          : memberAllow | memberDeny | P.EmbedLinks,
      ),
    threads: {
      create: async (v: any) => {
        Object.assign(thread, v);
        return thread;
      },
      fetchActive: async () => ({ threads: new Collection() }),
      fetchArchived: async () => ({
        threads: new Collection(),
        hasMore: false,
      }),
    },
    guild: {
      roles: { fetch: async () => new Collection([["staff", staff]]) },
      members: {
        fetchMe: async () => me,
        fetch: async () => ({ id: "reporter" }),
      },
      channels: {
        fetchActiveThreads: async () => ({ threads: new Collection() }),
      },
    },
  };
  const client: any = {
    channels: {
      fetch: async (id: string) => (id === "parent" ? parent : thread),
    },
  };
  const ui: any = { staffPanel: () => [] };
  const transport = new DiscordPrivateCases(
    client,
    "g",
    "app",
    ["staff"],
    100,
    ui,
  );
  const p: any = {
    caseId: "case",
    parentId: "parent",
    threadId: "thread",
    events: [
      {
        seq: 1,
        kind: "submitted",
        body: "hello",
        deliveryKey: "opaque",
        externalId: "message",
      },
    ],
  };
  const c: any = {
    id: "case",
    title: "Short title",
    reporter: "reporter",
    mode: "identified",
    createdAt: 1000000,
    state: "submitted",
    category: "bug",
    events: p.events,
    archived: false,
    locked: false,
  };
  return {
    transport,
    parent,
    thread,
    p,
    c,
    added,
    everyone,
    get sent() {
      return sent;
    },
  };
}
test("private parent rejects forum/public creation, missing attachments and unapproved role overrides", () => {
  const f = fixture();
  assert.equal(checkPrivateParentAccess("g", "app", ["staff"], f.parent), true);
  f.parent.type = 15;
  assert.equal(
    checkPrivateParentAccess("g", "app", ["staff"], f.parent),
    false,
  );
  f.parent.type = 0;
  f.everyone.allow.remove(P.AttachFiles);
  assert.equal(
    checkPrivateParentAccess("g", "app", ["staff"], f.parent),
    false,
  );
  f.everyone.allow.add(P.AttachFiles);
  f.parent.permissionOverwrites.cache.set("other", {
    id: "other",
    type: 0,
    allow: new PermissionsBitField(P.ManageThreads),
    deny: new PermissionsBitField(),
  });
  assert.equal(
    checkPrivateParentAccess("g", "app", ["staff"], f.parent),
    false,
  );
});
test("private create is uninvitable, verified before inviting, and publishes the short title with owner membership", async () => {
  const f = fixture();
  await f.transport.verify("parent");
  await f.transport.createThread({ ...f.p, threadId: null });
  assert.equal(f.thread.type, 12);
  assert.equal(f.thread.invitable, false);
  assert.equal(f.added.length, 0);
  await f.transport.sendEvent(f.p, f.c, f.p.events[0]);
  assert.deepEqual(f.sent.allowedMentions.parse, []);
  await f.transport.sync(f.p, f.c);
  assert.equal(f.thread.name, "Short title");
  assert.deepEqual(f.added, ["reporter"]);
  await f.transport.settle(f.p, { ...f.c, archived: true, locked: true });
  assert.equal(f.thread.locked, true);
  assert.equal(f.thread.archived, true);
  await f.transport.sync(f.p, { ...f.c, archived: false, locked: false });
  assert.equal(f.thread.archived, false);
  assert.equal(f.thread.locked, false);
});
test("private transport rejects wrong owner, public thread and wrong parent before posting or deleting", async () => {
  for (const patch of [
    { ownerId: "other" },
    { type: 11 },
    { parentId: "forum" },
    { guildId: "other" },
  ]) {
    const f = fixture();
    Object.assign(f.thread, patch);
    await assert.rejects(
      () => f.transport.sendEvent(f.p, f.c, f.p.events[0]),
      /private_thread_invalid/,
    );
    await assert.rejects(
      () => f.transport.remove("parent", "thread"),
      /private_thread_invalid/,
    );
    assert.equal(f.sent, undefined);
    assert.equal(f.thread.deleted, undefined);
  }
});
test("attachments require effective reporter access, and anonymous content never enters a private thread", async () => {
  const f = fixture();
  f.parent.permissionsFor = () => new PermissionsBitField(0n);
  await assert.rejects(() => f.transport.sync(f.p, f.c));
  assert.equal(f.added.length, 0);
  await assert.rejects(() =>
    f.transport.sendEvent(f.p, { ...f.c, mode: "anonymous" }, f.p.events[0]),
  );
  assert.equal(f.sent, undefined);
});
test("a successful edit response is insufficient when the private title readback disagrees", async () => {
  const f = fixture();
  const edit = f.thread.edit;
  f.thread.edit = async (v: any) => {
    const { name, ...rest } = v;
    return edit(rest);
  };
  await assert.rejects(
    () => f.transport.sync(f.p, f.c),
    /private_title_readback/,
  );
});

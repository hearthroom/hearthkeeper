import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { loadConfig } from "../src/config.js";
import { CommunityBot, type UpdateMetrics } from "../src/community/bot.js";
import {
  parseUpdateChannels,
  renderShippedNote,
  renderUpdateDigest,
  type UpdateDigest,
} from "../src/community/update-notice.js";
import { renderCommunityNotice, noticeLocales } from "../src/community/notice.js";
import { CaseStore } from "../src/cases/store.js";
import { eventName, forumContent } from "../src/cases/interactions.js";
import { createRuntime } from "../src/runtime.js";

const ZH = "300000000000000001",
  EN = "300000000000000002",
  REVIEW = "300000000000000003";
const env = {
  DISCORD_TOKEN: "test",
  DISCORD_APPLICATION_ID: "100000000000000001",
  DISCORD_GUILD_ID: "100000000000000002",
  COMMUNITY_ENABLED: "true",
  COMMUNITY_SITE_URL: "https://sukisuki.ai",
  COMMUNITY_BRIDGE_KEY: "33".repeat(32),
  COMMUNITY_DATABASE_PATH: "/var/lib/hearthkeeper/community.db",
};

test("update channels are optional, may repeat a language, and never a private destination", () => {
  assert.equal(loadConfig(env).community?.updates, undefined);
  assert.deepEqual(
    loadConfig({ ...env, COMMUNITY_UPDATES_CHANNELS: ` zh-Hant:${ZH} , en:${EN} ` }).community?.updates,
    { "zh-Hant": [ZH], en: [EN] },
  );
  // One language can go to several channels (a notice board and the lobby), in the configured order.
  assert.deepEqual(
    loadConfig({ ...env, COMMUNITY_UPDATES_CHANNELS: `zh-Hans:${ZH},zh-Hans:${EN}` }).community?.updates,
    { "zh-Hans": [ZH, EN] },
  );
  for (const bad of [
    `zh-TW:${ZH}`,
    "zh-Hant:123",
    `zh-Hant:${ZH},zh-Hant:${ZH}`,
    `zh-Hant:${ZH},en:${ZH}`,
    `zh-Hant ${ZH}`,
    ",",
  ])
    assert.throws(
      () => loadConfig({ ...env, COMMUNITY_UPDATES_CHANNELS: bad }),
      /COMMUNITY_UPDATES_CHANNELS/,
      bad,
    );
  assert.throws(
    () =>
      loadConfig({
        ...env,
        COMMUNITY_REVIEW_CHANNEL: REVIEW,
        COMMUNITY_UPDATES_CHANNELS: `en:${REVIEW}`,
      }),
    /COMMUNITY_UPDATES_CHANNELS/,
  );
  assert.equal(parseUpdateChannels("  "), undefined);
});

const digest = (over: Partial<UpdateDigest> = {}): UpdateDigest => ({
  heading: "Hearth Room 10/5 的更新",
  url: "https://sukisuki.ai/updates?from=discord&day=2026-10-05",
  items: [
    { tier: "highlight", title: "通知鈴鐺會告訴你誰回覆了你。", url: "https://sukisuki.ai/updates?from=discord#2026-10-04-notifications" },
    { tier: "feature", title: "Ping @everyone [x](https://evil.test) **bold**", url: "https://sukisuki.ai/updates?from=discord#2026-10-04-push" },
  ],
  fixesHeading: "修正",
  fixes: [{ title: "沙箱卡的手帳不會再存成空白。", url: "https://sukisuki.ai/updates?from=discord#2026-10-04-notepad" }],
  moreLabel: "看全部更新",
  moreUrl: "https://sukisuki.ai/updates?from=discord",
  ...over,
});

test("digest embeds lay out highlights, features and fixes without mentions or injected links", () => {
  const p = renderUpdateDigest(digest());
  assert.deepEqual(p.allowedMentions, { parse: [] });
  const e = p.embeds[0]!;
  assert.equal(e.title, "Hearth Room 10/5 的更新");
  assert.equal(e.url, "https://sukisuki.ai/updates?from=discord&day=2026-10-05");
  const lines = e.description.split("\n");
  assert.match(lines[0]!, /^✦ \[通知鈴鐺會告訴你誰回覆了你。\]\(https:\/\/sukisuki\.ai\/updates\?from=discord#2026-10-04-notifications\)$/);
  assert.match(lines[1]!, /^・\[/);
  assert.ok(!e.description.includes("@everyone"));
  assert.ok(e.description.includes("\\[x\\]\\(https://evil.test\\)"), "member-style markdown in a title is escaped");
  assert.ok(lines.includes("**修正**"));
  assert.equal(lines.at(-1), "[看全部更新](https://sukisuki.ai/updates?from=discord)");
  // Unsafe links are dropped to plain text, never rendered as links.
  const unsafe = renderUpdateDigest(digest({ items: [{ tier: "feature", title: "Bad", url: "javascript:alert(1)" }], fixes: [] }));
  assert.ok(unsafe.embeds[0]!.description.startsWith("・Bad\n"));
});

test("long digests stay under the Discord limit and never cut a link in half", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    tier: "feature" as const,
    title: `第 ${i} 項更新，標題寫得比較長一點以便測試截斷。`,
    url: `https://sukisuki.ai/updates?from=discord#2026-10-05-item-${i}`,
  }));
  const d = renderUpdateDigest(digest({ items })).embeds[0]!.description;
  assert.ok(d.length <= 3900, String(d.length));
  for (const line of d.split("\n").filter(Boolean))
    assert.match(line, /^(・|✦ )?\[.*\]\(https:\/\/[^)]+\)$|^\*\*.*\*\*$/, line);
  assert.ok(d.endsWith("[看全部更新](https://sukisuki.ai/updates?from=discord)"));
});

interface FakeMessage {
  id: string;
  createdTimestamp: number;
  author: { id: string };
  embeds: { title?: string; url?: string }[];
  edit: (p: any) => Promise<FakeMessage>;
  delete: () => Promise<void>;
}
function fakeChannel(opts: { public?: boolean; canSend?: boolean } = {}) {
  const state = { sent: 0, edited: 0, deleted: 0, lose: false, payloads: [] as any[], messages: new Map<string, FakeMessage>() };
  const make = (id: string, p: any): FakeMessage => {
    const m: FakeMessage = {
      id,
      createdTimestamp: Date.now(),
      author: { id: "bot" },
      embeds: p.embeds,
      edit: async (np: any) => {
        state.edited++;
        state.payloads.push(np);
        m.embeds = np.embeds;
        return m;
      },
      delete: async () => {
        state.deleted++;
        state.messages.delete(id);
      },
    };
    return m;
  };
  const everyone = { id: "guild" };
  const channel: any = {
    id: ZH,
    type: ChannelType.GuildText,
    guildId: "guild",
    guild: { roles: { everyone }, members: { fetchMe: async () => ({ id: "bot" }) } },
    permissionsFor: (who: any) => ({
      has: (flag: bigint) =>
        who === everyone
          ? opts.public !== false && flag === PermissionFlagsBits.ViewChannel
          : opts.canSend !== false,
    }),
    messages: {
      fetch: async (input: any) => {
        if (typeof input === "string") {
          const m = state.messages.get(input);
          if (!m) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return m;
        }
        return new Map([...state.messages].reverse());
      },
    },
    send: async (p: any) => {
      state.sent++;
      state.payloads.push(p);
      const m = make(String(400000000000000000n + BigInt(state.sent)), p);
      state.messages.set(m.id, m);
      if (state.lose) {
        state.lose = false;
        throw new Error("response lost");
      }
      return m;
    },
  };
  return { channel, state };
}
function metrics() {
  const seen: string[] = [];
  const m: UpdateMetrics = { delivery: (o) => void seen.push("delivery:" + o), report: (o) => void seen.push("report:" + o) };
  return { m, seen };
}
function updateBot(channel: any, m: UpdateMetrics, cases?: CaseStore) {
  const client = { user: { id: "bot" }, isReady: () => true, channels: { fetch: async () => channel } } as unknown as Client;
  return new CommunityBot(
    client,
    "guild",
    { site: "https://sukisuki.ai", key: "a".repeat(64), databasePath: ":memory:", channels: [], roles: [], updates: { "zh-Hant": [ZH] } },
    [],
    cases,
    undefined,
    () => {},
    undefined,
    m,
  );
}

test("a day's digest is posted once, then edited in place when the website revises it", async () => {
  const { channel, state } = fakeChannel();
  const { m, seen } = metrics();
  const bot = updateBot(channel, m);
  let messageId: string | null = null,
    revision = 1,
    current = digest();
  const acks: any[] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    if (op === "update-project") return { day: "2026-10-05", locale: "zh-Hant", revision, lease: "L" + revision, messageId, digest: current } as T;
    if (op === "update-ack") {
      acks.push(b);
      if (b.messageId) messageId = String(b.messageId);
      return { accepted: true } as T;
    }
    throw new Error("unexpected " + op);
  };
  try {
    await bot.updateDelivery("2026-10-05", "zh-Hant", ZH);
    revision = 2;
    current = digest({ fixes: [] });
    await bot.updateDelivery("2026-10-05", "zh-Hant", ZH);
    assert.equal(state.sent, 1);
    assert.equal(state.edited, 1);
    assert.deepEqual(state.payloads[0].allowedMentions, { parse: [] });
    assert.equal(state.payloads[0].enforceNonce, true);
    assert.deepEqual(acks.map((a) => [a.revision, a.lease, a.channel, a.messageId]), [
      [1, "L1", ZH, messageId],
      [2, "L2", ZH, messageId],
    ]);
    assert.ok(!state.payloads[1].embeds[0].description.includes("修正"));
    assert.deepEqual(seen, ["delivery:sent", "delivery:updated"]);
  } finally {
    bot.store.close();
  }
});

test("a withdrawn digest deletes the posted message and acknowledges the deletion", async () => {
  const { channel, state } = fakeChannel();
  const { m, seen } = metrics();
  const bot = updateBot(channel, m);
  let messageId: string | null = null,
    current = digest();
  const acks: any[] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    if (op === "update-project") return { day: "2026-10-05", locale: "zh-Hant", revision: acks.length + 1, lease: "L", messageId, digest: current } as T;
    acks.push(b);
    if (b.messageId) messageId = String(b.messageId);
    return { accepted: true } as T;
  };
  try {
    await bot.updateDelivery("2026-10-05", "zh-Hant", ZH);
    current = digest({ items: [], fixes: [] });
    await bot.updateDelivery("2026-10-05", "zh-Hant", ZH);
    assert.equal(state.deleted, 1);
    assert.equal(state.messages.size, 0);
    assert.equal(acks[1].deleted, true);
    assert.deepEqual(seen, ["delivery:sent", "delivery:deleted"]);
  } finally {
    bot.store.close();
  }
});

test("a lost send response is recovered from channel history instead of posting twice", async () => {
  const { channel, state } = fakeChannel();
  const { m } = metrics();
  const bot = updateBot(channel, m);
  const acks: any[] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    if (op === "update-project") return { day: "2026-10-05", locale: "zh-Hant", revision: 1, lease: "L", messageId: null, digest: digest() } as T;
    acks.push(b);
    return { accepted: true } as T;
  };
  try {
    state.lose = true;
    await assert.rejects(() => bot.updateDelivery("2026-10-05", "zh-Hant", ZH), /response lost/);
    assert.equal(acks[0].failed, true);
    await bot.updateDelivery("2026-10-05", "zh-Hant", ZH);
    assert.equal(state.sent, 1);
    assert.equal(state.edited, 1);
    assert.equal(acks[1].messageId, [...state.messages.keys()][0]);
  } finally {
    bot.store.close();
  }
});

test("digests are refused in non-public channels, channels the bot cannot post to, and over other authors' messages", async () => {
  for (const opts of [{ public: false }, { canSend: false }]) {
    const { channel, state } = fakeChannel(opts);
    const bot = updateBot(channel, metrics().m);
    let projected = false;
    bot.call = async <T>() => {
      projected = true;
      return {} as T;
    };
    try {
      await assert.rejects(() => bot.updateDelivery("2026-10-05", "zh-Hant", ZH), /update_channel_denied/);
      assert.equal(projected, false, "no website lease is taken for a refused channel");
      assert.equal(state.sent, 0);
    } finally {
      bot.store.close();
    }
  }
  const { channel, state } = fakeChannel();
  state.messages.set("500000000000000001", {
    id: "500000000000000001",
    createdTimestamp: Date.now(),
    author: { id: "someone" },
    embeds: [],
    edit: async () => {
      throw new Error("must not edit");
    },
    delete: async () => {},
  });
  const { m, seen } = metrics();
  const bot = updateBot(channel, m);
  const acks: any[] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    if (op === "update-project") return { day: "2026-10-05", locale: "zh-Hant", revision: 1, lease: "L", messageId: "500000000000000001", digest: digest() } as T;
    acks.push(b);
    return { accepted: true } as T;
  };
  try {
    await assert.rejects(() => bot.updateDelivery("2026-10-05", "zh-Hant", ZH), /update_message_denied/);
    assert.equal(acks[0].failed, true);
    assert.deepEqual(seen, ["delivery:failed"]);
  } finally {
    bot.store.close();
  }
});

test("the poll asks only for configured languages and skips digests for languages without a channel", async () => {
  const { channel, state } = fakeChannel();
  const bot = updateBot(channel, metrics().m);
  const calls: [string, Record<string, unknown>][] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    calls.push([op, b]);
    if (op === "events") return { receipts: [] } as T;
    if (op === "pending") return { subjects: [], jobs: [], notifications: [], review: null } as T;
    if (op === "update-pending")
      return { version: 1, digests: [{ day: "2026-10-05", locale: "en" }, { day: "2026-10-05", locale: "zh-Hant" }], reports: [] } as T;
    if (op === "update-project") return { day: "2026-10-05", locale: "zh-Hant", revision: 1, lease: "L", messageId: null, digest: digest() } as T;
    return { accepted: true } as T;
  };
  try {
    await bot.tick();
    const ops = calls.map((c) => c[0]);
    assert.deepEqual(ops, ["pending", "update-pending", "update-project", "update-ack"]);
    assert.deepEqual(calls[1]![1].locales, ["zh-Hant"]);
    assert.equal(calls[2]![1].locale, "zh-Hant");
    assert.equal(state.sent, 1);
  } finally {
    bot.store.close();
  }
});

test("a language with two channels posts to both, edits both, and one refused channel does not block the other", async () => {
  const board = fakeChannel({ canSend: false }),
    lobby = fakeChannel();
  board.channel.id = ZH;
  lobby.channel.id = EN;
  const byId: Record<string, any> = { [ZH]: board.channel, [EN]: lobby.channel };
  const { m, seen } = metrics();
  const client = { user: { id: "bot" }, isReady: () => true, channels: { fetch: async (id: string) => byId[id] } } as unknown as Client;
  const bot = new CommunityBot(
    client,
    "guild",
    { site: "https://sukisuki.ai", key: "a".repeat(64), databasePath: ":memory:", channels: [], roles: [], updates: { "zh-Hans": [ZH, EN] } },
    [],
    undefined,
    undefined,
    () => {},
    undefined,
    m,
  );
  // The website keeps one delivery per day and language; it hands back the message of the last channel acked.
  let site = { channel: null as string | null, message: null as string | null, delivered: 0 };
  let revision = 1,
    current = digest();
  const projected: string[] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    if (op === "events") return { receipts: [] } as T;
    if (op === "pending") return { subjects: [], jobs: [], notifications: [], review: null } as T;
    if (op === "update-pending")
      return { version: 1, digests: site.delivered < revision ? [{ day: "2026-10-05", locale: "zh-Hans" }] : [], reports: [] } as T;
    if (op === "update-project") {
      projected.push(String(b.channel));
      return { day: "2026-10-05", locale: "zh-Hans", revision, lease: "L", messageId: site.channel === b.channel ? site.message : null, digest: current } as T;
    }
    if (op === "update-ack") {
      if (b.messageId) site = { channel: String(b.channel), message: String(b.messageId), delivered: Number(b.revision) };
      return { accepted: true } as T;
    }
    throw new Error("unexpected " + op);
  };
  try {
    await bot.tick();
    assert.equal(board.state.sent, 0, "the refused notice board gets nothing");
    assert.equal(lobby.state.sent, 1, "the lobby still gets the digest");
    assert.deepEqual(projected, [EN], "no website lease is taken for the refused channel");
    // The notice board gains permission; the next revision reaches both, each editing or posting its own message.
    board.channel.permissionsFor = (who: any) => ({ has: (flag: bigint) => (who === board.channel.guild.roles.everyone ? flag === PermissionFlagsBits.ViewChannel : true) });
    revision = 2;
    current = digest({ fixes: [] });
    await bot.tick();
    assert.equal(board.state.sent, 1);
    assert.equal(lobby.state.sent, 1);
    assert.equal(lobby.state.edited, 1, "the lobby message is edited from the bot's own receipt");
    assert.deepEqual(projected, [EN, ZH, EN]);
    revision = 3;
    current = digest({ items: [{ tier: "highlight", title: "改過", url: "https://sukisuki.ai/updates?from=discord#x" }] });
    await bot.tick();
    assert.equal(board.state.sent, 1);
    assert.equal(board.state.edited, 1);
    assert.equal(lobby.state.edited, 2);
    assert.deepEqual(seen, ["delivery:sent", "delivery:sent", "delivery:updated", "delivery:updated", "delivery:updated"]);
  } finally {
    bot.store.close();
  }
});

function caseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "hk-shipped-"));
  const store = new CaseStore({ path: join(dir, "cases.db"), guildId: "guild", key: "11".repeat(32), lookupKey: "22".repeat(32) });
  return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const reporter = { guildId: "guild", userId: "reporter-1", staff: false };
const staff = { guildId: "guild", userId: "staff-1", staff: true };

test("a shipped note is a system event: idempotent, allowed on closed cases, and leaves the state alone", () => {
  const f = caseFixture();
  try {
    const c = f.store.create(reporter, { title: "通知看不到", body: "按讚沒有提醒", mode: "identified", category: "bug" }, "r1");
    const closed = f.store.act(staff, c.id, c.version, "close", "已排入開發", "s1");
    assert.equal(closed.state, "closed");
    const first = f.store.shipped(c.id, "這則回報相關的更新已經上線：通知鈴鐺會告訴你誰回覆了你。", "shipped:e1:" + c.id);
    assert.deepEqual(first, { mode: "identified", reporter: "reporter-1" });
    f.store.shipped(c.id, "duplicate", "shipped:e1:" + c.id);
    const view = f.store.read(reporter, c.id);
    assert.equal(view.state, "closed");
    assert.equal(view.version, closed.version + 1);
    assert.equal(view.events.filter((e) => e.kind === "shipped").length, 1, "reporters see the note once");
    assert.equal(view.sync, "pending", "the forum and private thread receive it through normal delivery");
    assert.equal(eventName("shipped"), "已上線");
    assert.equal(eventName("shipped", false), "Shipped");
    assert.match(forumContent(f.store.projection(c.id), view.events.at(-1)!), /已上線/);
    assert.equal(f.store.shipped("0".repeat(24), "x", "shipped:e1:none"), null);
  } finally {
    f.done();
  }
});

test("report jobs add the note and name the reporter to the website only for identified cases", async () => {
  const f = caseFixture();
  const { channel } = fakeChannel();
  const { m, seen } = metrics();
  const bot = updateBot(channel, m, f.store);
  const acks: any[] = [];
  bot.call = async <T>(op: string, b: Record<string, unknown> = {}) => {
    if (op === "update-report")
      return {
        entry: b.entry,
        case: b.case,
        titles: { "zh-Hant": "通知鈴鐺會告訴你誰回覆了你。", en: "The bell now tells you who replied." },
        url: "https://sukisuki.ai/updates#2026-10-04-notifications",
      } as T;
    acks.push(b);
    return { accepted: true } as T;
  };
  try {
    const identified = f.store.create(reporter, { title: "A", body: "B", mode: "identified" }, "r1");
    const anonymous = f.store.create({ ...reporter, userId: "reporter-2" }, { title: "C", body: "D", mode: "anonymous" }, "r2");
    await bot.updateReport("2026-10-04-notifications", identified.id);
    await bot.updateReport("2026-10-04-notifications", anonymous.id);
    await bot.updateReport("2026-10-04-notifications", "f".repeat(24));
    await bot.updateReport("2026-10-04-notifications", "not-a-case");
    assert.deepEqual(acks.map((a) => [a.outcome, a.reporter]), [
      ["delivered", "reporter-1"],
      ["delivered", undefined],
      ["missing", undefined],
      ["missing", undefined],
    ]);
    const note = f.store.read(reporter, identified.id).events.at(-1)!;
    assert.equal(note.kind, "shipped");
    assert.match(note.body, /這則回報相關的更新已經上線：通知鈴鐺/);
    assert.match(note.body, /https:\/\/sukisuki\.ai\/updates#2026-10-04-notifications/);
    assert.deepEqual(seen, ["report:delivered", "report:delivered", "report:missing", "report:missing"]);
  } finally {
    bot.store.close();
    f.done();
  }
});

test("shipped notes stay short, bilingual and link only to https", () => {
  const note = renderShippedNote({ "zh-Hant": "標題。", en: "Title." }, "javascript:alert(1)");
  assert.equal(note.split("\n").length, 2);
  assert.ok(!note.includes("javascript"));
  assert.ok(renderShippedNote({}, null).includes("An update related to this report is now live."));
});

test("report_shipped DMs speak every interface language and link to the release note", () => {
  for (const locale of noticeLocales) {
    const text = renderCommunityNotice("report_shipped", "/updates#2026-10-04-notifications", "https://sukisuki.ai", locale);
    assert.ok(text.endsWith("<https://sukisuki.ai/updates#2026-10-04-notifications>"), locale);
    assert.ok(!text.includes("HearthRoom 有新的通知"), locale);
  }
});

test("update metrics use bounded outcome labels", async () => {
  const r = createRuntime({ token: "fake", applicationId: "a", guildId: "g", metricsHost: "127.0.0.1", metricsPort: 11940, site: "https://sukisuki.ai" });
  r.updateMetrics.delivery("sent");
  r.updateMetrics.report("missing");
  (r.updateMetrics as any).delivery("something-else");
  const text = await r.metrics();
  assert.match(text, /hearthkeeper_update_delivery_total\{outcome="sent"\} 1/);
  assert.match(text, /hearthkeeper_update_delivery_total\{outcome="failed"\} 1/);
  assert.match(text, /hearthkeeper_update_report_total\{outcome="missing"\} 1/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Relay,
  RelayStore,
  relayKind,
  parseRelayQuery,
  relayRoute,
  type RelayFacts,
} from "../src/relay/core.js";
import { CommunityStore } from "../src/community/core.js";

const guild = "100000000000000002";
const bot = "100000000000000001";
const facts = (over: Partial<RelayFacts> = {}): RelayFacts => ({
  guildId: guild,
  botId: bot,
  author: { id: "200000000000000001", bot: false },
  webhookId: null,
  system: false,
  type: 0,
  mentionsBot: false,
  repliedAuthorId: null,
  privateCaseThread: false,
  forumThread: false,
  authorStaff: false,
  ...over,
});

test("relay triggers on a direct mention, a reply to the bot, and a reporter in a private case thread", () => {
  assert.equal(relayKind(facts({ mentionsBot: true }), guild), "mention");
  assert.equal(
    relayKind(facts({ type: 19, repliedAuthorId: bot }), guild),
    "reply",
  );
  assert.equal(
    relayKind(facts({ type: 19, repliedAuthorId: bot, mentionsBot: true }), guild),
    "reply",
  );
  assert.equal(relayKind(facts({ privateCaseThread: true }), guild), "case-thread");
});

test("relay ignores bots, webhooks, system posts, other guilds, staff work areas and plain chatter", () => {
  assert.equal(relayKind(facts(), guild), null);
  assert.equal(
    relayKind(facts({ type: 19, repliedAuthorId: "300000000000000001" }), guild),
    null,
  );
  for (const over of [
    { author: { id: bot, bot: true } },
    { author: { id: "400000000000000001", bot: true } },
    { webhookId: "500000000000000001" },
    { system: true },
    { type: 7 },
    { guildId: "600000000000000001" },
    { forumThread: true },
    { privateCaseThread: true, authorStaff: true, mentionsBot: true },
  ] as Partial<RelayFacts>[])
    assert.equal(relayKind(facts({ mentionsBot: true, ...over }), guild), null, JSON.stringify(over));
});

function setup(options: Partial<ConstructorParameters<typeof Relay>[1]> = {}) {
  let now = 1_000_000;
  const store = new RelayStore(new DatabaseSync(":memory:"));
  const relay = new Relay(store, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    gatewayReady: () => true,
    ...options,
  });
  return { store, relay, tick: (ms: number) => (now += ms), at: () => now };
}
const input = (over: Record<string, unknown> = {}) => ({
  kind: "mention" as const,
  authorId: "200000000000000001",
  channelId: "700000000000000001",
  channelName: "酒馆大厅",
  messageLink: "https://discord.com/channels/g/c/1",
  ...over,
});

test("a burst from one person becomes one event once it settles, carrying no author identity", async () => {
  const { relay, tick } = setup();
  assert.equal(relay.observe(input()), "queued");
  tick(3000);
  assert.equal(relay.observe(input({ messageLink: "https://discord.com/channels/g/c/2" })), "coalesced");
  assert.equal((await relay.events(0, 0)).events.length, 0, "still settling");
  tick(10_000);
  const r = await relay.events(0, 0);
  assert.equal(r.events.length, 1);
  const e = r.events[0]!;
  assert.equal(e.count, 2);
  assert.equal(e.firstMessage, "https://discord.com/channels/g/c/1");
  assert.equal(e.lastMessage, "https://discord.com/channels/g/c/2");
  assert.equal(e.channelName, "酒馆大厅");
  assert.ok(!JSON.stringify(r).includes("200000000000000001"));
});

test("an event already handed out never changes; later messages open a new event", async () => {
  const { relay, tick } = setup();
  relay.observe(input());
  tick(11_000);
  const first = await relay.events(0, 0);
  assert.equal(first.events.length, 1);
  assert.equal(relay.observe(input({ messageLink: "https://discord.com/channels/g/c/2" })), "queued");
  tick(11_000);
  const again = await relay.events(0, 0);
  assert.equal(again.events[0]!.count, 1);
  assert.equal(again.events.length, 2);
  const next = await relay.events(first.events[0]!.seq, 0);
  assert.deepEqual(next.events.map((e) => e.lastMessage), ["https://discord.com/channels/g/c/2"]);
});

test("continuous messages cannot hold an event back forever", async () => {
  const { relay, tick } = setup();
  relay.observe(input());
  for (let i = 0; i < 8; i++) {
    tick(5000);
    relay.observe(input({ messageLink: `https://discord.com/channels/g/c/${i + 2}` }));
  }
  const r = await relay.events(0, 0);
  assert.equal(r.events.length, 1);
});

test("events are handed out in order without skipping one that is still settling", async () => {
  const { relay, tick } = setup();
  relay.observe(input());
  tick(11_000);
  relay.observe(input({ authorId: "200000000000000002", messageLink: "https://discord.com/channels/g/c/9" }));
  relay.observe(input({ authorId: "200000000000000003", channelId: "700000000000000002" }));
  tick(1000);
  const r = await relay.events(0, 0);
  assert.equal(r.events.length, 1);
  assert.equal(r.latestSeq, 3);
});

test("one person and the whole server are rate limited, and the next event says how many were held back", async () => {
  const { relay, tick } = setup();
  const outcomes = [];
  for (let i = 0; i < 8; i++) {
    outcomes.push(relay.observe(input({ channelId: `70000000000000010${i}` })));
    tick(1000);
  }
  assert.deepEqual(outcomes.filter((o) => o === "queued").length, 6);
  assert.deepEqual(outcomes.filter((o) => o === "rate_limited").length, 2);
  tick(3_600_000);
  relay.observe(input({ authorId: "200000000000000009" }));
  tick(11_000);
  const r = await relay.events(0, 0);
  assert.equal(r.events.at(-1)!.suppressed, 2);

  const g = setup();
  let limited = 0;
  for (let i = 0; i < 70; i++)
    if (g.relay.observe(input({ authorId: `2000000000000${String(i).padStart(5, "0")}` })) === "rate_limited") limited++;
  assert.equal(limited, 10);
});

test("long poll waits for new events and returns empty when nothing arrives", async () => {
  const { relay, tick, at } = setup();
  const start = at();
  const empty = await relay.events(0, 25);
  assert.equal(empty.events.length, 0);
  assert.ok(at() - start >= 25_000);
  relay.observe(input());
  tick(11_000);
  assert.equal((await relay.events(0, 25)).events.length, 1);
});

test("the acknowledged cursor drives pending counts and the oldest pending age", async () => {
  const { relay, store, tick, at } = setup();
  relay.observe(input());
  tick(11_000);
  assert.deepEqual(store.stats(at()), { pending: 1, oldestAgeMs: 11_000 });
  const r = await relay.events(0, 0);
  await relay.events(r.events[0]!.seq, 0);
  assert.deepEqual(store.stats(at()), { pending: 0, oldestAgeMs: 0 });
});

test("a cursor older than retention reports a gap; a new store reports a new stream", async () => {
  const { relay, store, tick, at } = setup();
  relay.observe(input());
  tick(11_000);
  const r = await relay.events(0, 0);
  assert.equal(r.gap, false);
  tick(8 * 86_400_000);
  store.prune(at());
  relay.observe(input({ authorId: "200000000000000005" }));
  tick(11_000);
  const later = await relay.events(0, 0);
  assert.equal(later.gap, true);
  assert.equal(later.events[0]!.seq, 2);
  assert.equal((await relay.events(1, 0)).gap, false);
  assert.notEqual(setup().relay.streamId, relay.streamId);
});

test("sequence and stream survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  try {
    const path = join(dir, "relay.db");
    const a = new RelayStore(new DatabaseSync(path));
    const ra = new Relay(a, { now: () => 1, sleep: async () => {}, gatewayReady: () => true });
    ra.observe(input());
    const stream = ra.streamId;
    const b = new RelayStore(new DatabaseSync(path));
    const rb = new Relay(b, { now: () => 2, sleep: async () => {}, gatewayReady: () => true });
    rb.observe(input({ authorId: "200000000000000007" }));
    assert.equal(rb.streamId, stream);
    assert.equal(b.latestSeq(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gateway outages are recorded and reported with readiness", async () => {
  let ready = true;
  const { relay, store, tick } = setup({ gatewayReady: () => ready });
  store.gatewayDown(5000);
  store.gatewayDown(6000);
  store.gatewayUp(9000);
  ready = false;
  tick(1);
  const r = await relay.events(0, 0);
  assert.equal(r.gatewayReady, false);
  assert.deepEqual(r.gatewayGaps, [{ from: 5000, to: 9000 }]);
});

test("query parsing accepts only a cursor and a bounded wait", () => {
  assert.deepEqual(parseRelayQuery("/relay/events?after=12&wait=25"), { after: 12, wait: 25 });
  assert.deepEqual(parseRelayQuery("/relay/events"), { after: 0, wait: 0 });
  for (const bad of [
    "/relay/events?after=-1",
    "/relay/events?after=1.5",
    "/relay/events?wait=26",
    "/relay/events?after=abc",
    "/relay/other",
  ])
    assert.equal(parseRelayQuery(bad), null, bad);
});

test("the loopback route serves relay events, rejects bad queries and leaves other paths alone", async () => {
  const { relay, tick } = setup();
  let pulls = 0;
  const route = relayRoute(relay, () => pulls++);
  assert.equal(await route("/readyz"), null);
  assert.equal((await route("/relay/events?wait=99"))!.status, 400);
  relay.observe(input());
  tick(11_000);
  const ok = await route("/relay/events?after=0");
  assert.equal(ok!.status, 200);
  assert.equal((ok!.body as { events: unknown[] }).events.length, 1);
  assert.equal(pulls, 1);
});

test("replies to a daily update digest are recognised from the bot's own delivery receipts", () => {
  const store = new CommunityStore(":memory:");
  store.receipt("update:700000000000000001:2026-10-18:zh-Hans", "800000000000000001");
  store.receipt("review:abc", "800000000000000002");
  assert.equal(store.isUpdateDigest("800000000000000001"), true);
  assert.equal(store.isUpdateDigest("800000000000000002"), false);
  assert.equal(store.isUpdateDigest("800000000000000003"), false);
  store.close();
});

test("the Discord adapter reads only metadata and resolves replies with at most one read", async () => {
  const { relayInput } = await import("../src/relay/discord.js");
  const { ChannelType } = await import("discord.js");
  let fetches = 0;
  const fetchOutcomes: string[] = [];
  const ctx = {
    guildId: guild,
    botId: bot,
    staffRoleIds: ["900000000000000001"],
    forumId: "910000000000000001",
    privateCaseThread: (id: string) => id === "920000000000000001",
    digestMessage: (id: string) => id === "930000000000000001",
    recordFetch: (o: "success" | "failure") => fetchOutcomes.push(o),
  };
  const msg = (over: Record<string, unknown> = {}) =>
    ({
      id: "940000000000000001",
      guildId: guild,
      channelId: "700000000000000001",
      author: { id: "200000000000000001", bot: false },
      webhookId: null,
      system: false,
      type: 0,
      content: "",
      reference: null,
      member: { roles: { cache: new Map() } },
      guild: { members: { me: { roles: { botRole: { id: "950000000000000001" } } } } },
      mentions: { users: new Map(), roles: new Map(), repliedUser: null },
      channel: {
        name: "酒馆大厅",
        isThread: () => false,
        messages: {
          fetch: async () => {
            fetches++;
            return { author: { id: bot } };
          },
        },
      },
      ...over,
    }) as never;
  const mentioned = { users: new Map([[bot, {}]]), roles: new Map(), repliedUser: null };

  const m = await relayInput(msg({ mentions: mentioned }), ctx);
  assert.deepEqual(m, {
    kind: "mention",
    authorId: "200000000000000001",
    channelId: "700000000000000001",
    channelName: "酒馆大厅",
    messageLink: `https://discord.com/channels/${guild}/700000000000000001/940000000000000001`,
  });
  const role = await relayInput(
    msg({ mentions: { users: new Map(), roles: new Map([["950000000000000001", {}]]), repliedUser: null } }),
    ctx,
  );
  assert.equal(role?.kind, "mention");

  const reply = { type: 19, reference: { messageId: "930000000000000001" } };
  const r1 = await relayInput(msg(reply), ctx);
  assert.equal(r1?.kind, "reply");
  assert.equal(r1?.replyToDigest, true);
  assert.equal(r1?.replyTo, `https://discord.com/channels/${guild}/700000000000000001/930000000000000001`);
  await relayInput(msg(reply), ctx);
  assert.equal(fetches, 1, "the replied-to author is cached");
  assert.deepEqual(fetchOutcomes, ["success"]);
  const r2 = await relayInput(
    msg({ type: 19, reference: { messageId: "960000000000000001" }, mentions: { users: new Map(), roles: new Map(), repliedUser: { id: bot } } }),
    ctx,
  );
  assert.equal(r2?.replyToDigest, false);
  assert.equal(fetches, 1, "a known replied user needs no read");

  const thread = (over: Record<string, unknown>) => ({
    isThread: () => true,
    id: "920000000000000001",
    type: ChannelType.PrivateThread,
    ownerId: bot,
    parentId: "970000000000000001",
    parent: { name: "回报" },
    name: "hk-pending-x",
    ...over,
  });
  const c = await relayInput(msg({ channelId: "920000000000000001", channel: thread({}) }), ctx);
  assert.equal(c?.kind, "case-thread");
  assert.equal(c?.channelName, "回报 / hk-pending-x");
  const staff = { roles: { cache: new Map([["900000000000000001", {}]]) } };
  assert.equal(await relayInput(msg({ channel: thread({}), member: staff, mentions: mentioned }), ctx), null);
  assert.equal(
    await relayInput(msg({ channel: thread({ type: ChannelType.PublicThread, parentId: ctx.forumId }), mentions: mentioned }), ctx),
    null,
  );
  assert.equal(await relayInput(msg({ author: { id: bot, bot: true }, mentions: mentioned }), ctx), null);
  assert.equal(await relayInput(msg(), ctx), null);
});

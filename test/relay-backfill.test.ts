import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Relay, RelayStore } from "../src/relay/core.js";
import { backfill, snowflakeAt } from "../src/relay/backfill.js";

const input = (link: string) => ({
  kind: "mention" as const,
  authorId: "200000000000000001",
  channelId: "700000000000000001",
  channelName: "酒馆大厅",
  messageLink: link,
});

test("the same message seen by the gateway and by backfill is relayed once", () => {
  let now = 1_000_000;
  const relay = new Relay(new RelayStore(new DatabaseSync(":memory:")), {
    now: () => now,
    sleep: async () => {},
    gatewayReady: () => true,
  });
  assert.equal(relay.observe(input("https://discord.com/channels/g/c/1")), "queued");
  now += 1000;
  assert.equal(relay.observe(input("https://discord.com/channels/g/c/1")), "duplicate");
  now += 400_000;
  assert.equal(relay.observe(input("https://discord.com/channels/g/c/1")), "duplicate", "even after the burst window");
});

test("a gap closed after a complete backfill is marked recovered", () => {
  const store = new RelayStore(new DatabaseSync(":memory:"));
  store.gatewayDown(1000);
  assert.deepEqual(store.openGap(), { from: 1000 });
  store.gatewayUp(2000, true);
  store.gatewayDown(3000);
  store.gatewayUp(4000, false);
  assert.equal(store.openGap(), null);
  assert.deepEqual(store.gatewayGaps(), [
    { from: 1000, to: 2000, recovered: true },
    { from: 3000, to: 4000, recovered: false },
  ]);
});

type Msg = { id: string };
function fakeGuild(channels: Record<string, { last: string | null; messages?: string[]; fail?: boolean }>) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      listChannels: async () =>
        Object.entries(channels).map(([id, c]) => ({ id, lastMessageId: c.last })),
      fetchAfter: async (channel: string, after: string): Promise<Msg[]> => {
        calls.push(`${channel}>${after}`);
        const c = channels[channel]!;
        if (c.fail) throw new Error("missing access");
        return (c.messages ?? [])
          .filter((id) => BigInt(id) > BigInt(after))
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
          .slice(0, 100)
          .map((id) => ({ id }));
      },
      sleep: async () => {},
    },
  };
}

test("backfill reads only channels active since the gap, oldest first, through every page", async () => {
  const now = Date.parse("2026-10-18T13:00:00Z");
  const from = now - 600_000;
  const cut = BigInt(snowflakeAt(from - 180_000));
  const after = (ms: number) => String(cut + BigInt(ms) * 4_194_304n);
  const busy = Array.from({ length: 150 }, (_, i) => after(i + 1));
  const { deps, calls } = fakeGuild({
    a: { last: busy.at(-1)!, messages: busy },
    b: { last: String(cut - 1n) },
    c: { last: null },
    d: { last: after(5), messages: [String(cut - 5n), after(5)] },
  });
  const handled: string[] = [];
  const r = await backfill({ ...deps, handle: async (m: Msg) => void handled.push(m.id) }, from, now);
  assert.deepEqual(r, { channels: 2, messages: 151, complete: true });
  assert.deepEqual(handled.slice(0, 3), busy.slice(0, 3));
  assert.ok(handled.includes(after(5)));
  assert.ok(!handled.includes(String(cut - 5n)), "messages before the gap are not replayed");
  assert.ok(calls.every((c) => !c.startsWith("b>") && !c.startsWith("c>")));
});

test("backfill is bounded and reports incomplete when it had to stop or skip", async () => {
  const now = Date.parse("2026-10-18T13:00:00Z");
  const from = now - 600_000;
  const cut = BigInt(snowflakeAt(from - 180_000));
  const ids = (n: number) => Array.from({ length: n }, (_, i) => String(cut + BigInt(i + 1) * 4_194_304n));
  const huge = ids(700);
  const big = fakeGuild({ a: { last: huge.at(-1)!, messages: huge } });
  let n = 0;
  const r1 = await backfill({ ...big.deps, handle: async () => void n++ }, from, now);
  assert.equal(r1.complete, false);
  assert.equal(n, 500);

  const failing = fakeGuild({ a: { last: ids(1)[0]!, fail: true }, b: { last: ids(1)[0]!, messages: ids(1) } });
  let m = 0;
  const r2 = await backfill({ ...failing.deps, handle: async () => void m++ }, from, now);
  assert.equal(r2.complete, false);
  assert.equal(m, 1, "one unreadable channel does not stop the rest");

  const many: Record<string, { last: string; messages: string[] }> = {};
  for (let i = 0; i < 60; i++) many[`ch${i}`] = { last: ids(1)[0]!, messages: ids(1) };
  const wide = fakeGuild(many);
  const r3 = await backfill({ ...wide.deps, handle: async () => {} }, from, now);
  assert.equal(r3.channels, 50);
  assert.equal(r3.complete, false);

  const old = fakeGuild({ a: { last: ids(1)[0]!, messages: ids(1) } });
  const r4 = await backfill({ ...old.deps, handle: async () => {} }, now - 3 * 86_400_000, now);
  assert.equal(r4.complete, false, "gaps longer than a day are only partly recovered");
  assert.ok(old.calls[0]!.endsWith(`>${snowflakeAt(now - 86_400_000)}`));
});

import { GapRecovery } from "../src/relay/backfill.js";
import { gatewayReadinessEvents } from "../src/runtime.js";
import { Events } from "discord.js";

function recoverySetup() {
  const store = new RelayStore(new DatabaseSync(":memory:"));
  let ready = true;
  let now = 10_000;
  const runs: number[] = [];
  const outcomes: string[] = [];
  let next: () => Promise<{ complete: boolean }> = async () => ({ complete: true });
  const rec = new GapRecovery({
    store,
    now: () => now,
    ready: () => ready,
    read: async (from) => {
      runs.push(from);
      return next();
    },
    record: (o) => outcomes.push(o),
  });
  return {
    store, rec, runs, outcomes,
    setReady: (v: boolean) => (ready = v),
    tick: (ms: number) => (now += ms),
    onRead: (f: () => Promise<{ complete: boolean }>) => (next = f),
  };
}

test("a ready gateway reads the open gap back once and marks it recovered", async () => {
  const s = recoverySetup();
  s.rec.down();
  s.tick(5000);
  await s.rec.up();
  assert.deepEqual(s.runs, [10_000]);
  assert.equal(s.store.openGap(), null);
  assert.equal(s.store.gatewayGaps()[0]!.recovered, true);
  await s.rec.up();
  assert.equal(s.runs.length, 1, "nothing left to read");
});

test("a disconnect during the read-back reads again instead of claiming recovery", async () => {
  const s = recoverySetup();
  s.rec.down();
  let first = true;
  s.onRead(async () => {
    if (first) {
      first = false;
      s.rec.down();
      s.tick(1000);
      void s.rec.up();
    }
    return { complete: true };
  });
  await s.rec.up();
  assert.equal(s.runs.length, 2);
  assert.equal(s.store.gatewayGaps().length, 1);
  assert.equal(s.store.gatewayGaps()[0]!.recovered, true);
});

test("a read-back still running when the gateway drops leaves the gap open", async () => {
  const s = recoverySetup();
  s.rec.down();
  s.onRead(async () => {
    s.setReady(false);
    s.rec.down();
    return { complete: true };
  });
  await s.rec.up();
  assert.deepEqual(s.store.openGap(), { from: 10_000 });
});

test("a failed or partial read-back closes the gap as not recovered so the operators are told", async () => {
  const s = recoverySetup();
  s.rec.down();
  s.onRead(async () => {
    throw new Error("503");
  });
  await s.rec.up();
  assert.equal(s.store.openGap(), null);
  assert.equal(s.store.gatewayGaps()[0]!.recovered, false);
  s.tick(1000);
  s.rec.down();
  s.onRead(async () => ({ complete: false }));
  await s.rec.up();
  assert.equal(s.store.gatewayGaps()[1]!.recovered, false);
  assert.deepEqual(s.outcomes, ["failed", "partial"]);
});

test("a new gateway session and a returning guild both count as becoming ready", () => {
  for (const e of [Events.ShardReady, Events.ShardResume, Events.GuildAvailable, Events.GuildCreate])
    assert.ok((gatewayReadinessEvents as readonly Events[]).includes(e), e);
});

test("gaps longer than threads stay active are not claimed complete", async () => {
  const now = Date.parse("2026-10-18T13:00:00Z");
  const g = fakeGuild({});
  const r = await backfill({ ...g.deps, handle: async () => {} }, now - 2 * 3_600_000, now);
  assert.equal(r.complete, false);
  const short = await backfill({ ...g.deps, handle: async () => {} }, now - 600_000, now);
  assert.equal(short.complete, true);
});

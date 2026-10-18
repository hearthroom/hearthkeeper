import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// Relay: tells the operators' local machine that someone @-mentioned or replied to the bot.
// Only metadata leaves this process: links, channel, kind, counts. Never content, never who wrote it;
// the author ID lives only in the in-memory coalescing and rate-limit tables below.

export type RelayKind = "mention" | "reply" | "case-thread";

export interface RelayFacts {
  guildId: string | null;
  botId: string;
  author: { id: string; bot: boolean };
  webhookId: string | null;
  system: boolean;
  type: number;
  mentionsBot: boolean;
  repliedAuthorId: string | null;
  privateCaseThread: boolean;
  forumThread: boolean;
  authorStaff: boolean;
}

export function relayKind(f: RelayFacts, guild: string): RelayKind | null {
  if (
    f.guildId !== guild ||
    f.author.bot ||
    f.webhookId ||
    f.system ||
    ![0, 19].includes(f.type) ||
    // The case forum is the staff work area; staff messages there already drive the case workflow.
    f.forumThread
  )
    return null;
  // Staff in a private report thread are the ones handling it.
  if (f.privateCaseThread && f.authorStaff) return null;
  if (f.repliedAuthorId === f.botId) return "reply";
  if (f.mentionsBot) return "mention";
  if (f.privateCaseThread) return "case-thread";
  return null;
}

export interface RelayInput {
  kind: RelayKind;
  authorId: string;
  channelId: string;
  channelName: string;
  messageLink: string;
  replyTo?: string;
  replyToDigest?: boolean;
}

export interface RelayEvent {
  seq: number;
  kind: RelayKind;
  channelId: string;
  channelName: string;
  firstMessage: string;
  lastMessage: string;
  count: number;
  suppressed: number;
  replyTo: string | null;
  replyToDigest: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  seq: number;
  kind: RelayKind;
  channel_id: string;
  channel_name: string;
  first_message: string;
  last_message: string;
  count: number;
  suppressed: number;
  reply_to: string | null;
  reply_to_digest: number;
  created_at: number;
  updated_at: number;
}
const toEvent = (r: Row): RelayEvent => ({
  seq: r.seq,
  kind: r.kind,
  channelId: r.channel_id,
  channelName: r.channel_name,
  firstMessage: r.first_message,
  lastMessage: r.last_message,
  count: r.count,
  suppressed: r.suppressed,
  replyTo: r.reply_to,
  replyToDigest: r.reply_to_digest === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class RelayStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS relay_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,channel_id TEXT NOT NULL,channel_name TEXT NOT NULL,first_message TEXT NOT NULL,last_message TEXT NOT NULL,count INTEGER NOT NULL,suppressed INTEGER NOT NULL,reply_to TEXT,reply_to_digest INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS relay_gaps(started_at INTEGER PRIMARY KEY,ended_at INTEGER);`);
    db.prepare("INSERT OR IGNORE INTO relay_meta VALUES('stream',?)").run(randomUUID());
  }
  private meta(key: string) {
    return (
      this.db.prepare("SELECT value FROM relay_meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  private metaNumber(key: string) {
    return Number(this.meta(key) ?? 0);
  }
  private raise(key: string, value: number) {
    if (value > this.metaNumber(key))
      this.db.prepare("INSERT OR REPLACE INTO relay_meta VALUES(?,?)").run(key, String(value));
  }
  streamId() {
    return this.meta("stream")!;
  }
  latestSeq() {
    return Number(
      (
        this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='relay_events'").get() as
          | { seq: number }
          | undefined
      )?.seq ?? 0,
    );
  }
  create(e: Omit<RelayInput, "authorId">, suppressed: number, now: number) {
    const r = this.db
      .prepare("INSERT INTO relay_events(kind,channel_id,channel_name,first_message,last_message,count,suppressed,reply_to,reply_to_digest,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?,?)")
      .run(e.kind, e.channelId, e.channelName, e.messageLink, e.messageLink, suppressed, e.replyTo ?? null, e.replyToDigest ? 1 : 0, now, now);
    return Number(r.lastInsertRowid);
  }
  /** Folds a message into an event nobody has been handed yet; an event already handed out never changes. */
  merge(seq: number, messageLink: string, now: number) {
    if (seq <= this.metaNumber("handed")) return false;
    return (
      this.db
        .prepare("UPDATE relay_events SET last_message=?,count=count+1,updated_at=? WHERE seq=?")
        .run(messageLink, now, seq).changes === 1
    );
  }
  /** Settled events after the cursor, in order; stops at the first one still settling so a cursor never skips it. */
  page(after: number, now: number, settleMs: number, holdMaxMs: number, limit = 50) {
    const rows = this.db
      .prepare("SELECT * FROM relay_events WHERE seq>? ORDER BY seq LIMIT ?")
      .all(after, limit) as unknown as Row[];
    const out: RelayEvent[] = [];
    for (const r of rows) {
      if (r.updated_at > now - settleMs && r.created_at > now - holdMaxMs) break;
      out.push(toEvent(r));
    }
    if (out.length) this.raise("handed", out.at(-1)!.seq);
    return out;
  }
  /**
   * A cursor from an older stream may be ahead of this one; it cannot acknowledge events it never saw.
   * Consumers advance the cursor only from returned events; after a stream change they restart from 0.
   */
  ack(after: number) {
    this.raise("acked", Math.min(after, this.metaNumber("handed")));
  }
  gap(after: number) {
    return after < this.metaNumber("pruned");
  }
  stats(now: number) {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM relay_events WHERE seq>?")
      .get(this.metaNumber("acked")) as { n: number; oldest: number | null };
    return { pending: r.n, oldestAgeMs: r.oldest === null ? 0 : Math.max(0, now - r.oldest) };
  }
  prune(now: number, keepMs = 7 * 86_400_000) {
    const cut = now - keepMs;
    const last = this.db
      .prepare("SELECT MAX(seq) AS seq FROM relay_events WHERE created_at<?")
      .get(cut) as { seq: number | null };
    if (last.seq !== null) this.raise("pruned", last.seq);
    this.db.prepare("DELETE FROM relay_events WHERE created_at<?").run(cut);
    this.db.prepare("DELETE FROM relay_gaps WHERE ended_at IS NOT NULL AND ended_at<?").run(cut);
  }
  heartbeat(now: number) {
    this.db.prepare("INSERT OR REPLACE INTO relay_meta VALUES('heartbeat',?)").run(String(now));
  }
  /** Discord does not replay messages missed while the process was down: open a gap from the last sign of life. */
  boot(now: number) {
    const last = this.meta("heartbeat");
    this.gatewayDown(last ? Number(last) : now);
    this.heartbeat(now);
  }
  gatewayDown(now: number) {
    if (!this.db.prepare("SELECT 1 FROM relay_gaps WHERE ended_at IS NULL").get())
      this.db.prepare("INSERT OR IGNORE INTO relay_gaps VALUES(?,NULL)").run(now);
  }
  gatewayUp(now: number) {
    this.db.prepare("UPDATE relay_gaps SET ended_at=? WHERE ended_at IS NULL").run(now);
  }
  gatewayGaps() {
    return (
      this.db.prepare("SELECT started_at,ended_at FROM relay_gaps ORDER BY started_at").all() as {
        started_at: number;
        ended_at: number | null;
      }[]
    ).map((g) => ({ from: g.started_at, to: g.ended_at }));
  }
}

export interface RelayOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  gatewayReady: () => boolean;
  perAuthorHour?: number;
  globalHour?: number;
  /** A burst is handed out once its author has been quiet this long. */
  settleMs?: number;
  /** ...or once it is this old, so a steady stream cannot hold it back. */
  holdMaxMs?: number;
  coalesceMs?: number;
}

const HOUR = 3_600_000;

export class Relay {
  private groups = new Map<string, { seq: number; at: number }>();
  private authors = new Map<string, number[]>();
  private global: number[] = [];
  private suppressed = 0;
  private o: Required<RelayOptions>;
  constructor(
    private store: RelayStore,
    options: RelayOptions,
  ) {
    this.o = {
      perAuthorHour: 6,
      globalHour: 60,
      settleMs: 10_000,
      holdMaxMs: 30_000,
      coalesceMs: 180_000,
      ...options,
    };
  }
  get streamId() {
    return this.store.streamId();
  }
  observe(e: RelayInput): "queued" | "coalesced" | "rate_limited" {
    const now = this.o.now();
    this.forget(now);
    const key = e.authorId + ":" + e.channelId;
    const group = this.groups.get(key);
    if (group && now - group.at < this.o.coalesceMs && this.store.merge(group.seq, e.messageLink, now)) {
      group.at = now;
      return "coalesced";
    }
    const mine = this.authors.get(e.authorId) ?? [];
    if (mine.length >= this.o.perAuthorHour || this.global.length >= this.o.globalHour) {
      this.suppressed++;
      return "rate_limited";
    }
    const { authorId: _author, ...event } = e;
    const seq = this.store.create(event, this.suppressed, now);
    this.suppressed = 0;
    mine.push(now);
    this.authors.set(e.authorId, mine);
    this.global.push(now);
    this.groups.set(key, { seq, at: now });
    return "queued";
  }
  private forget(now: number) {
    const cut = now - HOUR;
    this.global = this.global.filter((t) => t > cut);
    for (const [k, v] of this.authors) {
      const kept = v.filter((t) => t > cut);
      if (kept.length) this.authors.set(k, kept);
      else this.authors.delete(k);
    }
    for (const [k, v] of this.groups) if (v.at <= now - this.o.coalesceMs) this.groups.delete(k);
  }
  async events(after: number, waitSeconds: number) {
    this.store.ack(after);
    const start = this.o.now();
    let events = this.store.page(after, start, this.o.settleMs, this.o.holdMaxMs);
    while (!events.length && this.o.now() - start < waitSeconds * 1000) {
      await this.o.sleep(1000);
      events = this.store.page(after, this.o.now(), this.o.settleMs, this.o.holdMaxMs);
    }
    return {
      streamId: this.store.streamId(),
      latestSeq: this.store.latestSeq(),
      serverTime: this.o.now(),
      gatewayReady: this.o.gatewayReady(),
      gap: this.store.gap(after),
      gatewayGaps: this.store.gatewayGaps(),
      events,
    };
  }
}

export function parseRelayQuery(url: string) {
  const u = new URL(url, "http://127.0.0.1");
  if (u.pathname !== "/relay/events") return null;
  const num = (name: string, max: number) => {
    const raw = u.searchParams.get(name);
    if (raw === null) return 0;
    if (!/^\d{1,15}$/.test(raw)) return null;
    const n = Number(raw);
    return n <= max ? n : null;
  };
  const after = num("after", Number.MAX_SAFE_INTEGER);
  const wait = num("wait", 25);
  return after === null || wait === null ? null : { after, wait };
}

/** HTTP route for the loopback health server; null when the path is not a relay path. */
export function relayRoute(relay: Relay, onPull: () => void) {
  return async (url: string) => {
    if (!url.startsWith("/relay/")) return null;
    if (new URL(url, "http://127.0.0.1").pathname !== "/relay/events")
      return { status: 404, body: { status: "not_found" } };
    const q = parseRelayQuery(url);
    if (!q) return { status: 400, body: { status: "bad_request" } };
    const body = await relay.events(q.after, q.wait);
    onPull();
    return { status: 200, body };
  };
}

// After a restart or a fresh gateway session, Discord does not replay what the bot missed.
// Read those messages back over REST and feed them through the same relay path; the store
// drops anything the gateway already delivered.

const DISCORD_EPOCH = 1420070400000n;
export const snowflakeAt = (ms: number) =>
  String((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n);

export interface BackfillDeps<M extends { id: string }> {
  /** Text channels and active threads the bot can read, with their newest message id. */
  listChannels: () => Promise<{ id: string; lastMessageId: string | null }[]>;
  /** Up to 100 messages after `after`, oldest first. */
  fetchAfter: (channelId: string, after: string) => Promise<M[]>;
  handle: (m: M) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface BackfillLimits {
  maxChannels: number;
  maxPagesPerChannel: number;
  maxWindowMs: number;
  /** Threads archived during a longer gap drop out of the active list, so such a gap cannot be read completely. */
  activeThreadMs: number;
  /** Read from slightly before the gap so a message at its edge is not missed. */
  marginMs: number;
  pauseMs: number;
}

const defaults: BackfillLimits = {
  maxChannels: 50,
  maxPagesPerChannel: 5,
  maxWindowMs: 86_400_000,
  // A dead connection can go unnoticed for about two heartbeats before reconnecting; duplicates are dropped anyway.
  marginMs: 180_000,
  pauseMs: 1000,
  activeThreadMs: 3_600_000,
};

export async function backfill<M extends { id: string }>(
  deps: BackfillDeps<M>,
  gapFrom: number,
  now: number,
  limits: Partial<BackfillLimits> = {},
) {
  const l = { ...defaults, ...limits };
  let complete = gapFrom - l.marginMs >= now - l.maxWindowMs && now - gapFrom <= l.activeThreadMs;
  const start = snowflakeAt(Math.max(gapFrom - l.marginMs, now - l.maxWindowMs));
  const active = (await deps.listChannels()).filter(
    (c) => c.lastMessageId && BigInt(c.lastMessageId) > BigInt(start),
  );
  if (active.length > l.maxChannels) complete = false;
  let messages = 0;
  const channels = active.slice(0, l.maxChannels);
  for (const c of channels) {
    let after = start;
    try {
      for (let page = 0; ; page++) {
        if (page === l.maxPagesPerChannel) {
          complete = false;
          break;
        }
        await deps.sleep(l.pauseMs);
        const list = await deps.fetchAfter(c.id, after);
        for (const m of list) {
          await deps.handle(m);
          messages++;
        }
        if (list.length < 100) break;
        after = list.at(-1)!.id;
      }
    } catch {
      complete = false;
    }
  }
  return { channels: channels.length, messages, complete };
}

interface GapStore {
  openGap(): { from: number } | null;
  gatewayDown(now: number): void;
  gatewayUp(now: number, recovered: boolean): void;
}

/**
 * Runs the read-back whenever the gateway becomes ready with a gap open. A disconnect during the
 * read bumps the generation, so the gap is read again rather than marked recovered; a failed or
 * partial read closes the gap as not recovered so the operators' machine tells someone to look.
 */
export class GapRecovery {
  private generation = 0;
  // discord.js keeps reporting ready while a shard reconnects, so track it here: cleared on every
  // disconnect, set again only by a readiness event.
  private connected = false;
  private running: Promise<void> | null = null;
  private again = false;
  constructor(
    private o: {
      store: GapStore;
      now: () => number;
      ready: () => boolean;
      read: (from: number) => Promise<{ complete: boolean }>;
      record: (outcome: "complete" | "partial" | "failed") => void;
    },
  ) {}
  down() {
    this.connected = false;
    this.generation++;
    try {
      this.o.store.gatewayDown(this.o.now());
    } catch {
      // Called from Discord event listeners: a storage error must not escape into the gateway code.
      this.o.record("failed");
    }
  }
  async up() {
    this.connected = true;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
  private async loop() {
    do {
      this.again = false;
      try {
        const gap = this.o.store.openGap();
        if (!gap) return;
        const generation = this.generation;
        let outcome: "complete" | "partial" | "failed";
        try {
          outcome = (await this.o.read(gap.from)).complete ? "complete" : "partial";
        } catch {
          outcome = "failed";
        }
        // Still disconnected: leave the gap open for the next readiness event.
        if (!this.connected || !this.o.ready()) return;
        // Dropped and came back during the read: read the same gap again.
        if (generation !== this.generation) {
          this.again = true;
          continue;
        }
        this.o.store.gatewayUp(this.o.now(), outcome === "complete");
        this.o.record(outcome);
      } catch {
        // A storage error must not take the bot down; the gap stays as it was.
        this.o.record("failed");
        return;
      }
    } while (this.again);
  }
}

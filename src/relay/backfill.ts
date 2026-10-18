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
  /** Read from slightly before the gap so a message at its edge is not missed. */
  marginMs: number;
  pauseMs: number;
}

const defaults: BackfillLimits = {
  maxChannels: 50,
  maxPagesPerChannel: 5,
  maxWindowMs: 86_400_000,
  marginMs: 60_000,
  pauseMs: 1000,
};

export async function backfill<M extends { id: string }>(
  deps: BackfillDeps<M>,
  gapFrom: number,
  now: number,
  limits: Partial<BackfillLimits> = {},
) {
  const l = { ...defaults, ...limits };
  let complete = gapFrom - l.marginMs >= now - l.maxWindowMs;
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

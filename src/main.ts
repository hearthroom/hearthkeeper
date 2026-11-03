import { CommunityBot } from "./community/bot.js";
import { CaseAdminCounts } from './cases/admin.js';
import type { PrivateProjection, CaseView } from './cases/store.js';
import { CaseStore } from "./cases/store.js";
import { DiscordCases } from "./cases/discord.js";
import { DiscordPrivateCases } from "./cases/private-discord.js";
import { PrivateDeliveryWorker } from "./cases/private-delivery.js";
import { DeliveryWorker } from "./cases/delivery.js";
import { Client, Events, PermissionFlagsBits, Status, type Message, type ThreadChannel } from "discord.js";
import { loadConfig } from "./config.js";
import {
  createRuntime,
  gatewayIntents,
  gatewayReadinessEvents,
  presenceActivity,
} from "./runtime.js";
import { createHealthServer } from "./health.js";
import { Relay, RelayStore, relayRoute } from "./relay/core.js";
import { relayIncomingMessage, relayNewReport } from "./relay/discord.js";
import { backfill, GapRecovery } from "./relay/backfill.js";

async function start() {
  const config = loadConfig(process.env);
  const adminCounts = config.cases ? new CaseAdminCounts(config.cases.databasePath + '.admin-metrics') : undefined;
  const runtime = createRuntime(config, () => adminCounts?.rows() ?? []);
  const client = new Client({
    intents: gatewayIntents,
    allowedMentions: { parse: [] },
  });
  const store = config.cases
    ? new CaseStore({
        path: config.cases.databasePath,
        guildId: config.guildId,
        key: config.cases.key,
        lookupKey: config.cases.lookupKey,
      })
    : undefined;
  const cases =
    store && config.cases
      ? new DiscordCases(
          client,
          config.guildId,
          config.applicationId,
          config.cases,
          store,
          runtime.recordCaseInteraction,
        )
      : undefined;
  const worker =
    store && cases
      ? new DeliveryWorker(store, cases, runtime.recordDelivery)
      : undefined;
  const privateCases =
    cases && config.cases
      ? new DiscordPrivateCases(
          client,
          config.guildId,
          config.applicationId,
          config.cases.staffRoleIds,
          config.cases.privateMaxActive ?? 100,
          cases.ui,
        )
      : undefined;
  const privateWorker =
    store && privateCases
      ? new PrivateDeliveryWorker(
          store,
          privateCases,
          runtime.recordPrivateDelivery,
          relayCaseOpened,
        )
      : undefined;
  const community = config.community
    ? new CommunityBot(
        client,
        config.guildId,
        config.community,
        config.cases?.staffRoleIds ?? [],
        store,
        config.cases?.privateParentId,
        runtime.recordCommunity,
        runtime.reviewMetrics,
        runtime.updateMetrics,
      )
    : undefined;
  const relayStore =
    community && config.community?.relay
      ? new RelayStore(community.store.db)
      : undefined;
  // The client stays "ready" while a shard reconnects; the shard status does not.
  const gatewayReady = () =>
    client.isReady() &&
    client.ws.shards.every((s) => s.status === Status.Ready) &&
    Boolean(client.guilds.cache.get(config.guildId)?.available);
  const relay = relayStore
    ? new Relay(relayStore, {
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()),
        gatewayReady,
      })
    : undefined;
  const relayHealth = (pulled: boolean) => {
    if (!relayStore) return;
    const s = relayStore.stats(Date.now());
    if (pulled) runtime.relayMetrics.pulled(s.pending, s.oldestAgeMs);
    else runtime.relayMetrics.health(s.pending, s.oldestAgeMs);
  };
  relayStore?.boot(Date.now());
  const relayTimer = setInterval(() => {
    relayStore?.heartbeat(Date.now());
    relayStore?.prune(Date.now());
    relayHealth(false);
  }, 60000);
  relayTimer.unref();
  const communityTimer = setInterval(() => void community?.tick(), 15000);
  communityTimer.unref();
  let ticking = false;
  const tick = async () => {
    if (ticking || !client.isReady() || !cases || !store || !worker) return;
    ticking = true;
    try {
      let safe = true;
      try {
        await cases.verify();
        await cases.reconcileThreads();
      } catch {
        safe = false;
      }
      await worker.run();
      runtime.setCaseHealth(store.pending().length, safe);
      if (privateCases && privateWorker) {
        const parents = new Set(store.privateParents());
        if (config.cases?.privateParentId)
          parents.add(config.cases.privateParentId);
        let privateSafe = parents.size > 0;
        try {
          for (const parent of parents) await privateCases.verify(parent);
          await privateCases.reconcile(store);
        } catch {
          privateSafe = false;
        }
        await privateWorker.run();
        runtime.setPrivateHealth(store.privatePendingCount(), privateSafe);
      }
    } catch {
      runtime.setCaseHealth(store.pending().length, false);
      runtime.setPrivateHealth(store.privatePendingCount(), false);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), 15000);
  timer.unref();
  const status = (event: string) => console.log(JSON.stringify({ event }));
  function relayCaseOpened(p: PrivateProjection, c: CaseView) {
    const first = p.events.find((e) => e.seq === 1 && e.status === 'done');
    if (!relay || p.projectedVersion !== 0 || p.status === 'ready' || !p.threadId || !first?.externalId) return;
    const input = {
      kind: 'case-opened' as const, authorId: 'system', channelId: p.threadId,
      channelName: `Reports / ${c.category}`,
      messageLink: `https://discord.com/channels/${config.guildId}/${p.threadId}/${first.externalId}`,
    };
    runtime.relayMetrics.event(input.kind, relay.observe(input));
  }
  const relayReport = async (thread: ThreadChannel) => {
    if (!relay) return;
    // Managed cases announce only from their first verified private sync. In
    // particular, reconnect reads must not announce already-synced legacy cases.
    const input = await relayNewReport(thread, {
      guildId: config.guildId,
      botId: client.user?.id ?? config.applicationId,
      reportParentId: config.cases?.privateParentId,
      privateCaseThread: (id) => !!store?.privateCaseForThread(id),
      seen: (id) => relay.reportSeen(id),
    });
    if (input) runtime.relayMetrics.event(input.kind, relay.observe(input));
  };
  const relayMessage = async (message: Message) => {
    if (!relay || !community) return;
    await relayIncomingMessage(message, {
      guildId: config.guildId,
      botId: client.user?.id ?? config.applicationId,
      staffRoleIds: config.cases?.staffRoleIds ?? [],
      forumId: config.cases?.forumId,
      listenChannelIds: config.community?.relayListenChannels,
      privateCaseThread: (id) => !!store?.privateCaseForThread(id),
      digestMessage: (id) => community.store.isUpdateDigest(id),
      recordFetch: runtime.relayMetrics.fetch,
    }, {
      report: relayReport,
      observe: (input) => { runtime.relayMetrics.event(input.kind, relay.observe(input)); },
      reportFailed: () => status('relay_report_failed'),
    });
  };
  // Discord does not replay what a new gateway session missed: read the gap back over REST.
  const readBack = async (from: number) => {
    const guild = await client.guilds.fetch(config.guildId);
    const me = await guild.members.fetchMe();
    return backfill<Message>(
      {
        listChannels: async () => {
          const channels = [...(await guild.channels.fetch()).values()];
          const threads = [...(await guild.channels.fetchActiveThreads()).threads.values()];
          return [...channels, ...threads].flatMap((c) =>
            c &&
            c.isTextBased() &&
            !(c.isThread() && c.parentId === config.cases?.forumId) &&
            // The bot cannot have been mentioned where it cannot read; listing those would only fail.
            c.permissionsFor(me)?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
            ])
              ? [{ id: c.id, lastMessageId: c.lastMessageId ?? null }]
              : [],
          );
        },
        fetchAfter: async (id, after) => {
          const c = await client.channels.fetch(id);
          if (!c?.isTextBased()) return [];
          const page = await c.messages.fetch({ after, limit: 100 });
          return [...page.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        },
        handle: relayMessage,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref()),
      },
      from,
      Date.now(),
    );
  };
  const recovery = relayStore
    ? new GapRecovery({
        store: relayStore,
        now: Date.now,
        ready: gatewayReady,
        read: readBack,
        record: (outcome) => {
          runtime.relayMetrics.backfill(outcome);
          status("relay_backfill_" + outcome);
        },
      })
    : undefined;
  const updateReady = () => {
    const ready = gatewayReady();
    runtime.setReady(ready);
    if (ready) void recovery?.up().catch(() => status("relay_backfill_failed"));
    else recovery?.down();
  };


  client.on(Events.ClientReady, (readyClient) => {
    readyClient.user.setActivity(presenceActivity);
    updateReady();
    status("gateway_connected");
    void tick();
  });
  client.on(Events.ShardDisconnect, () => {
    runtime.setReady(false);
    recovery?.down();
    status("gateway_disconnected");
  });
  client.on(Events.ShardReconnecting, () => {
    runtime.setReady(false);
    recovery?.down();
  });
  for (const event of gatewayReadinessEvents) client.on(event, updateReady);
  client.on(Events.Error, () => status("discord_error"));
  client.on(Events.ShardError, () => status("gateway_error"));
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (community && (await community.handle(interaction))) return;
      if (cases && (await cases.ui.handle(interaction))) {
        void tick();
        return;
      }
      if (interaction.isChatInputCommand()) await runtime.handle(interaction);
    } catch {
      status("interaction_failed");
    }
  });

  client.on(Events.ThreadCreate, (thread) => {
    void relayReport(thread).catch(() => status("relay_failed"));
  });

  client.on(Events.ThreadUpdate, async (_oldThread, thread) => {
    try {
      if (cases && (await cases.onThreadUpdate(thread))) void tick();
    } catch {
      runtime.recordDelivery("failure");
      status("case_thread_update_failed");
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    void relayMessage(message).catch(() => status("relay_failed"));
    try {
      community?.onMessage(message);
      if (cases && (await cases.onStaffMessage(message))) void tick();
    } catch {
      runtime.recordDelivery("failure");
      status("case_status_update_failed");
    }
  });

  const server = createHealthServer(
    runtime,
    relay ? relayRoute(relay, () => relayHealth(true)) : undefined,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.metricsPort, config.metricsHost, resolve);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    runtime.setReady(false);
    recovery?.down();
    clearInterval(timer);
    clearInterval(communityTimer);
    clearInterval(relayTimer);
    server.close();
    await client.destroy();
    adminCounts?.close();
    status("stopped");
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  try {
    await client.login(config.token);
  } catch {
    await shutdown();
    throw new Error("Discord login failed");
  }
}

start().catch(() => {
  console.error(JSON.stringify({ event: "startup_failed" }));
  process.exitCode = 1;
});

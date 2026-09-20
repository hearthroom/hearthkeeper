import { CaseStore } from "./cases/store.js";
import { DiscordCases } from "./cases/discord.js";
import { DeliveryWorker } from "./cases/delivery.js";
import { Client, Events } from "discord.js";
import { loadConfig } from "./config.js";
import { createRuntime, gatewayIntents } from "./runtime.js";
import { createHealthServer } from "./health.js";

async function start() {
  const config = loadConfig(process.env);
  const runtime = createRuntime(config);
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
        )
      : undefined;
  const worker =
    store && cases
      ? new DeliveryWorker(store, cases, runtime.recordDelivery)
      : undefined;
  let ticking = false;
  const tick = async () => {
    if (ticking || !client.isReady() || !cases || !store || !worker) return;
    ticking = true;
    try {
      let safe = true;
      try {
        await cases.verify();
      } catch {
        safe = false;
      }
      await worker.run();
      runtime.setCaseHealth(store.pending().length, safe);
    } catch {
      runtime.setCaseHealth(store.pending().length, false);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), 15000);
  timer.unref();
  const status = (event: string) => console.log(JSON.stringify({ event }));
  const updateReady = () =>
    runtime.setReady(
      client.isReady() &&
        Boolean(client.guilds.cache.get(config.guildId)?.available),
    );

  client.on(Events.ClientReady, () => {
    updateReady();
    status("gateway_connected");
    void tick();
  });
  client.on(Events.ShardDisconnect, () => {
    runtime.setReady(false);
    status("gateway_disconnected");
  });
  client.on(Events.ShardReconnecting, () => runtime.setReady(false));
  client.on(Events.ShardResume, updateReady);
  client.on(Events.GuildCreate, updateReady);
  client.on(Events.GuildDelete, updateReady);
  client.on(Events.GuildUnavailable, updateReady);
  client.on(Events.Error, () => status("discord_error"));
  client.on(Events.ShardError, () => status("gateway_error"));
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (cases && (await cases.ui.handle(interaction))) {
        void tick();
        return;
      }
      if (interaction.isChatInputCommand()) await runtime.handle(interaction);
    } catch {
      status("interaction_failed");
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (cases && (await cases.onStaffMessage(message))) void tick();
    } catch {
      runtime.recordDelivery("failure");
      status("case_status_update_failed");
    }
  });

  const server = createHealthServer(runtime);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.metricsPort, config.metricsHost, resolve);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    runtime.setReady(false);
    clearInterval(timer);
    server.close();
    await client.destroy();
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

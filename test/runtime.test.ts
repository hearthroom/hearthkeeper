import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import {
  createRuntime,
  commandDefinitions,
  communityCommands,
  gatewayIntents,
  presenceActivity,
} from "../src/runtime.js";
import { ActivityType, GatewayIntentBits, MessageFlags } from "discord.js";
import { createHealthServer } from "../src/health.js";

const env = {
  DISCORD_TOKEN: "synthetic-test-token",
  DISCORD_APPLICATION_ID: "100000000000000001",
  DISCORD_GUILD_ID: "100000000000000002",
};

test("configuration requires explicit app, guild and token without exposing values", () => {
  for (const field of Object.keys(env)) {
    const input: Record<string, string> = { ...env };
    delete input[field];
    assert.throws(() => loadConfig(input), new RegExp(field));
  }
  assert.throws(
    () => loadConfig({ ...env, DISCORD_GUILD_ID: "sensitive-invalid-value" }),
    (e) => e instanceof Error && !e.message.includes("sensitive-invalid-value"),
  );
  assert.throws(() => loadConfig({ ...env, METRICS_PORT: "0" }));
  assert.throws(() => loadConfig({ ...env, METRICS_PORT: "65536" }));
  assert.equal(loadConfig(env).metricsHost, "127.0.0.1");
});

test("commands use non-privileged Guilds and GuildMessages intents and include the delivered report workflow", () => {
  assert.deepEqual(gatewayIntents, [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ]);
  assert.deepEqual(
    commandDefinitions.map((x) => x.name),
    ["hearthkeeper", "feedback", "myreports", "cases", "ping"],
  );
  assert.ok(commandDefinitions.every((x) => x.dm_permission === false));
});

test("commands include Chinese names and Simplified and Traditional descriptions", () => {
  const hearthkeeper = commandDefinitions.find((x) => x.name === "hearthkeeper")!;
  assert.deepEqual(hearthkeeper.name_localizations, {
    "zh-TW": "蘇綺",
    "zh-CN": "苏绮",
  });
  for (const command of [...commandDefinitions, ...communityCommands]) {
    assert.ok(command.description_localizations["zh-TW"], command.name);
    assert.ok(command.description_localizations["zh-CN"], command.name);
    for (const option of
      "options" in command && command.options ? command.options : []) {
      assert.ok(option.description_localizations["zh-TW"], option.name);
      assert.ok(option.description_localizations["zh-CN"], option.name);
    }
  }
  const ping = commandDefinitions.find((x) => x.name === "ping")!;
  assert.equal(ping.description, "Check whether Suki is responding");
  assert.equal(ping.description_localizations["zh-TW"], "確認蘇綺是否在線");
  assert.equal(ping.description_localizations["zh-CN"], "确认苏绮是否在线");
});

test("presence uses Suki's custom status line", () => {
  assert.deepEqual(presenceActivity, {
    name: "Custom Status",
    type: ActivityType.Custom,
    state: "陪你再 roll 一次",
  });
});

function interaction(
  guildId = env.DISCORD_GUILD_ID,
  commandName = "hearthkeeper",
  locale = "zh-TW",
) {
  const replies: unknown[] = [];
  return {
    guildId,
    commandName,
    locale,
    replies,
    applicationId: env.DISCORD_APPLICATION_ID,
    isChatInputCommand: () => true,
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  };
}

test("menu is private, disables mentions and has only public guide links", async () => {
  const runtime = createRuntime(loadConfig(env));
  const input = interaction();
  await runtime.handle(input);
  assert.equal(input.replies.length, 1);
  const reply = input.replies[0] as any;
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.match(reply.content, /尚未開放/);
  assert.equal(reply.components[0].components.length, 3);
  for (const button of reply.components[0].components) {
    assert.equal(button.style, 5);
    assert.ok(button.url.startsWith("https://"));
    assert.equal(button.custom_id, undefined);
  }
});

test("menu site buttons follow the configured site instead of a hardcoded domain", async () => {
  const runtime = createRuntime(loadConfig({ ...env, SITE_URL: "https://example.test" }));
  const input = interaction();
  await runtime.handle(input);
  const [visit, guide] = (input.replies[0] as any).components[0].components;
  assert.equal(visit.url, "https://example.test");
  assert.equal(guide.url, "https://example.test/guide");
  assert.ok(!JSON.stringify(input.replies).includes("hearthroom.club"));
});

test("unsupported locale falls back to English", async () => {
  const runtime = createRuntime(loadConfig(env));
  const input = interaction(undefined, undefined, "ja");
  await runtime.handle(input);
  assert.match((input.replies[0] as any).content, /not available yet/);
});

test("menu and ping use Simplified Chinese, Traditional Chinese and English by locale", async () => {
  const runtime = createRuntime(loadConfig(env));
  for (const [locale, heading, menuText, pingText] of [
    ["zh-CN", "**苏绮**", "还没有开放", "我在这里！"],
    ["zh-TW", "**蘇綺**", "尚未開放", "我在這裡！"],
    ["en-US", "**Suki**", "not available yet", "I'm here!"],
  ]) {
    const menu = interaction(undefined, "hearthkeeper", locale);
    await runtime.handle(menu);
    assert.ok((menu.replies[0] as any).content.includes(heading));
    assert.ok((menu.replies[0] as any).content.includes(menuText));

    const ping = interaction(undefined, "ping", locale);
    await runtime.handle(ping);
    assert.equal((ping.replies[0] as any).content, pingText);
  }
});

test("foreign guild, DM and mismatched application are rejected before responding", async () => {
  const runtime = createRuntime(loadConfig(env));
  for (const patch of [
    { guildId: "100000000000000003" },
    { guildId: null },
    { applicationId: "100000000000000004" },
  ]) {
    const input = { ...interaction(), ...patch };
    await runtime.handle(input);
    assert.equal(input.replies.length, 0);
  }
});

test("unknown commands and noncommands do not produce a response", async () => {
  const runtime = createRuntime(loadConfig(env));
  for (const input of [
    interaction(undefined, "unsupported"),
    { ...interaction(), isChatInputCommand: () => false },
  ]) {
    await runtime.handle(input);
    assert.equal(input.replies.length, 0);
  }
});

test("reply failures are counted without leaking payloads into telemetry", async () => {
  const runtime = createRuntime(loadConfig(env));
  const input = {
    ...interaction(),
    reply: async () => {
      throw new Error("synthetic-private-payload");
    },
  };
  await runtime.handle(input);
  const metrics = await runtime.metrics();
  assert.match(
    metrics,
    /hearthkeeper_interactions_total\{action="menu",outcome="failure"\} 1/,
  );
  assert.ok(!metrics.includes("synthetic-private-payload"));
  assert.ok(!metrics.includes(env.DISCORD_GUILD_ID));
});

test("readiness reflects live Discord connection, not only process existence", async () => {
  const runtime = createRuntime(loadConfig(env));
  assert.equal(runtime.health("/readyz").status, 503);
  runtime.setReady(true);
  assert.equal(runtime.health("/readyz").status, 200);
  runtime.setReady(false);
  assert.equal(runtime.health("/readyz").status, 503);
  assert.equal(runtime.health("/healthz").status, 200);
  assert.equal(runtime.health("/unknown").status, 404);
  const input = interaction(undefined, "ping");
  await runtime.handle(input);
  assert.equal((input.replies[0] as any).content, "我在這裡！");
  assert.match(await runtime.metrics(), /action="ping",outcome="success"/);
});

test("systemd confines secrets and privileges and uses a dedicated account", () => {
  const unit = readFileSync(
    new URL("../deploy/hearthkeeper.service", import.meta.url),
    "utf8",
  );
  for (const required of [
    "User=hearthkeeper",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateTmp=true",
    "EnvironmentFile=/etc/hearthkeeper/runtime.env",
    "Restart=on-failure",
    "UMask=0077",
  ])
    assert.ok(unit.includes(required), required);
  assert.ok(!unit.includes("DISCORD_TOKEN="));
});

test("real HTTP server returns readiness and metrics without public binding", async () => {
  const runtime = createRuntime(loadConfig(env));
  const server = createHealthServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base + "/readyz")).status, 503);
    runtime.setReady(true);
    assert.equal((await fetch(base + "/readyz")).status, 200);
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/unknown")).status, 404);
    assert.equal(
      (await fetch(base + "/healthz", { method: "POST" })).status,
      405,
    );
    const metrics = await fetch(base + "/metrics");
    assert.match(await metrics.text(), /hearthkeeper_gateway_ready 1/);
    assert.equal(metrics.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
test("private conversation monitoring separates safety, pending and bounded outcomes without identity labels", async () => {
  const config = {
    token: "test",
    applicationId: "app",
    guildId: "g",
    metricsHost: "127.0.0.1" as const,
    metricsPort: 11940,
    site: "https://sukisuki.ai",
  };
  const r = createRuntime(config);
  r.recordPrivateDelivery("capacity");
  r.setPrivateHealth(2, false);
  const text = await r.metrics();
  assert.match(text, /hearthkeeper_case_private_pending 2/);
  assert.match(text, /hearthkeeper_case_private_ready 0/);
  assert.match(
    text,
    /hearthkeeper_case_private_delivery_total\{outcome="capacity"\} 1/,
  );
});

test("case interaction metrics use bounded kinds and outcomes without case identities", async () => {
  const r = createRuntime(loadConfig(env));
  r.recordCaseInteraction("modal", "success");
  r.recordCaseInteraction("button", "failure");
  r.recordCaseInteraction("command", "denied");
  const text = await r.metrics();
  assert.match(text, /hearthkeeper_case_interactions_total\{kind="modal",outcome="success"\} 1/);
  assert.match(text, /hearthkeeper_case_interactions_total\{kind="button",outcome="failure"\} 1/);
  assert.match(text, /hearthkeeper_case_interactions_total\{kind="command",outcome="denied"\} 1/);
  assert.ok(!text.includes(env.DISCORD_GUILD_ID));
});

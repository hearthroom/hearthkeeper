import { Registry, Counter, Gauge, Histogram } from "@prometheus-io/client";
import {
  GatewayIntentBits,
  MessageFlags,
  type InteractionReplyOptions,
} from "discord.js";
import type { Config } from "./config.js";

export const gatewayIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
export const commandDefinitions = [
  {
    name: "hearthkeeper",
    description: "Open the HearthRoom community menu",
    description_localizations: { "zh-TW": "開啟 HearthRoom 社群選單" },
    dm_permission: false,
  },
  {
    name: "feedback",
    description: "Submit a private or anonymous report",
    description_localizations: { "zh-TW": "提出私密或匿名回報" },
    dm_permission: false,
  },
  {
    name: "myreports",
    description: "View your reports and replies",
    description_localizations: { "zh-TW": "查看我的回報與社管回覆" },
    dm_permission: false,
  },
  {
    name: "cases",
    description: "Manage reports (authorized moderators only)",
    description_localizations: { "zh-TW": "處理回報案件（限授權社管）" },
    dm_permission: false,
  },
  {
    name: "ping",
    description: "Check whether Hearthkeeper is responding",
    description_localizations: { "zh-TW": "確認爐邊管家是否正常回應" },
    dm_permission: false,
  },
];

export function commandsFor(config: Config) {
  return config.cases
    ? commandDefinitions
    : commandDefinitions.filter((c) =>
        ["hearthkeeper", "ping"].includes(c.name),
      );
}

export interface CommandInteraction {
  guildId: string | null;
  applicationId: string;
  commandName?: string;
  locale?: string;
  isChatInputCommand(): boolean;
  reply(payload: InteractionReplyOptions): Promise<unknown>;
}

function menu(zh: boolean): InteractionReplyOptions {
  return {
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
    content: zh
      ? "**爐邊管家**\nHearthRoom 社群與寫卡指南在這裡。\n\n回報與案件追蹤尚未開放，請先聯絡社管。"
      : "**Hearthkeeper**\nExplore HearthRoom and the character creation guide.\n\nReports and case tracking are not available yet. Please contact a moderator.",
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: zh ? "前往社群站" : "Visit HearthRoom",
            url: "https://hearthroom.club",
          },
          {
            type: 2,
            style: 5,
            label: zh ? "閱讀寫卡指南" : "Read the guide",
            url: "https://hearthroom.club/guide",
          },
          {
            type: 2,
            style: 5,
            label: zh ? "查看開源專案" : "View source",
            url: "https://github.com/hearthroom/hearthkeeper",
          },
        ],
      },
    ],
  };
}

export function createRuntime(config: Config) {
  const registry = new Registry();
  const interactions = new Counter({
    name: "hearthkeeper_interactions_total",
    help: "Handled command outcomes.",
    labelNames: ["action", "outcome"],
    registers: [registry],
  });
  const readyGauge = new Gauge({
    name: "hearthkeeper_gateway_ready",
    help: "Whether the configured Discord guild is connected.",
    registers: [registry],
  });
  const ack = new Histogram({
    name: "hearthkeeper_interaction_ack_seconds",
    help: "Time to send the initial Discord interaction response.",
    labelNames: ["action"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3],
    registers: [registry],
  });
  const delivery = new Counter({
    name: "hearthkeeper_case_delivery_total",
    help: "Case synchronization attempts.",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const pending = new Gauge({
    name: "hearthkeeper_case_pending",
    help: "Cases awaiting forum synchronization.",
    registers: [registry],
  });
  const forum = new Gauge({
    name: "hearthkeeper_case_forum_ready",
    help: "Whether the staff forum passes its permission checks.",
    registers: [registry],
  });
  let ready = false;
  readyGauge.set(0);
  return {
    recordDelivery(outcome: "success" | "failure") {
      delivery.inc({ outcome });
    },
    setCaseHealth(count: number, safe: boolean) {
      pending.set(count);
      forum.set(safe ? 1 : 0);
    },
    setReady(value: boolean) {
      ready = value;
      readyGauge.set(value ? 1 : 0);
    },
    async handle(input: CommandInteraction) {
      if (!input.isChatInputCommand()) return;
      if (
        input.guildId !== config.guildId ||
        input.applicationId !== config.applicationId
      ) {
        interactions.inc({ action: "other", outcome: "denied" });
        return;
      }
      const action =
        input.commandName === "hearthkeeper"
          ? "menu"
          : input.commandName === "ping"
            ? "ping"
            : null;
      if (!action) {
        interactions.inc({ action: "other", outcome: "denied" });
        return;
      }
      const start = performance.now();
      try {
        const zh = input.locale === "zh-TW";
        await input.reply(
          action === "menu"
            ? menu(zh)
            : {
                content: zh
                  ? "爐邊管家可以正常回應。"
                  : "Hearthkeeper is responding.",
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
              },
        );
        ack.observe({ action }, (performance.now() - start) / 1000);
        interactions.inc({ action, outcome: "success" });
      } catch {
        // Never log Discord payloads, identity fields or raw SDK errors.
        interactions.inc({ action, outcome: "failure" });
      }
    },
    metrics: () => registry.metrics(),
    contentType: registry.contentType,
    health(path: string) {
      if (path === "/healthz")
        return { status: 200, body: { status: "alive" } };
      if (path === "/readyz")
        return {
          status: ready ? 200 : 503,
          body: { status: ready ? "ready" : "not_ready" },
        };
      return { status: 404, body: { status: "not_found" } };
    },
  };
}

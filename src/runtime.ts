import { Registry, Counter, Gauge, Histogram } from "@prometheus-io/client";
import {
  ActivityType,
  GatewayIntentBits,
  MessageFlags,
  type InteractionReplyOptions,
} from "discord.js";
import type { Config } from "./config.js";
import { localize, userLanguage, type UserLanguage } from "./locale.js";

export const gatewayIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
];
export const presenceActivity = {
  name: "Custom Status",
  type: ActivityType.Custom,
  state: "陪你再 roll 一次",
};
export const communityCommands = [
  {
    name: "card",
    description: "Preview a public HearthRoom card",
    description_localizations: {
      "zh-TW": "預覽 HearthRoom 公開角色卡",
      "zh-CN": "预览 HearthRoom 公开角色卡",
    },
    dm_permission: false,
    options: [
      {
        type: 3 as const,
        name: "number",
        description: "Public HearthRoom card number",
        description_localizations: {
          "zh-TW": "HearthRoom 公開角色卡編號",
          "zh-CN": "HearthRoom 公开角色卡编号",
        },
        required: true,
      },
    ],
  },
  {
    name: "link",
    description: "Link your HearthRoom community account",
    description_localizations: {
      "zh-TW": "連結 HearthRoom 社群帳號",
      "zh-CN": "连接 HearthRoom 社群账号",
    },
    dm_permission: false,
  },
  {
    name: "level",
    description: "View your community level and badges",
    description_localizations: {
      "zh-TW": "查看社群等級與徽章",
      "zh-CN": "查看社群等级与徽章",
    },
    dm_permission: false,
  },
  {
    name: "subscriptions",
    description: "Manage community notifications",
    description_localizations: {
      "zh-TW": "管理社群通知",
      "zh-CN": "管理社群通知",
    },
    dm_permission: false,
  },
  {
    name: "xp",
    description: "Pause or resume chat XP",
    description_localizations: {
      "zh-TW": "停止或恢復發言計分",
      "zh-CN": "停止或恢复发言计分",
    },
    dm_permission: false,
    options: [
      {
        type: 5 as const,
        name: "enabled",
        description: "Whether to count future chat XP",
        description_localizations: {
          "zh-TW": "是否計算之後的聊天經驗值",
          "zh-CN": "是否计算之后的聊天经验值",
        },
        required: true,
      },
    ],
  },
];
export const commandDefinitions = [
  {
    name: "hearthkeeper",
    name_localizations: { "zh-TW": "蘇綺", "zh-CN": "苏绮" },
    description: "Open the HearthRoom community menu",
    description_localizations: {
      "zh-TW": "開啟 HearthRoom 社群選單",
      "zh-CN": "打开 HearthRoom 社群菜单",
    },
    dm_permission: false,
  },
  {
    name: "feedback",
    description: "Submit a private or anonymous report",
    description_localizations: {
      "zh-TW": "提出私密或匿名回報",
      "zh-CN": "提交私密或匿名反馈",
    },
    dm_permission: false,
  },
  {
    name: "myreports",
    description: "View your reports and replies",
    description_localizations: {
      "zh-TW": "查看我的回報與社管回覆",
      "zh-CN": "查看我的反馈与社管回复",
    },
    dm_permission: false,
  },
  {
    name: "cases",
    description: "Manage reports (authorized moderators only)",
    description_localizations: {
      "zh-TW": "處理回報案件（限授權社管）",
      "zh-CN": "处理反馈案件（仅限授权社管）",
    },
    dm_permission: false,
  },
  {
    name: "ping",
    description: "Check whether Suki is responding",
    description_localizations: {
      "zh-TW": "確認蘇綺是否在線",
      "zh-CN": "确认苏绮是否在线",
    },
    dm_permission: false,
  },
];

export function commandsFor(config: Config) {
  return [
    ...(config.cases
      ? commandDefinitions
      : commandDefinitions.filter((c) =>
          ["hearthkeeper", "ping"].includes(c.name),
        )),
    ...(config.community ? communityCommands : []),
  ];
}

export interface CommandInteraction {
  guildId: string | null;
  applicationId: string;
  commandName?: string;
  locale?: string;
  isChatInputCommand(): boolean;
  reply(payload: InteractionReplyOptions): Promise<unknown>;
}

function menu(language: UserLanguage, site: string): InteractionReplyOptions {
  return {
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
    content: localize(
      language,
      "**蘇綺**\n我把 HearthRoom 社群與寫卡指南放在這裡啦。\n\n回報與案件追蹤尚未開放，請先聯絡社管。",
      "**苏绮**\n我把 HearthRoom 社群与写卡指南放在这里啦。\n\n反馈与案件追踪还没有开放，请先联系社管。",
      "**Suki**\nI've put the HearthRoom community and character creation guide right here.\n\nReports and case tracking are not available yet. Please contact a moderator.",
    ),
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: localize(
              language,
              "前往社群站",
              "前往社群站",
              "Visit HearthRoom",
            ),
            url: site,
          },
          {
            type: 2,
            style: 5,
            label: localize(
              language,
              "閱讀寫卡指南",
              "阅读写卡指南",
              "Read the guide",
            ),
            url: site + "/guide",
          },
          {
            type: 2,
            style: 5,
            label: localize(
              language,
              "查看開源專案",
              "查看开源项目",
              "View source",
            ),
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
  const communitySync = new Counter({
    name: "hearthkeeper_community_sync_total",
    help: "Community synchronization outcomes.",
    labelNames: ["outcome"],
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
  const caseInteractions = new Counter({
    name: "hearthkeeper_case_interactions_total",
    help: "Case interaction outcomes without private payloads.",
    labelNames: ["kind", "outcome"],
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
  const privateDelivery = new Counter({
    name: "hearthkeeper_case_private_delivery_total",
    help: "Private conversation synchronization outcomes.",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const privatePending = new Gauge({
    name: "hearthkeeper_case_private_pending",
    help: "Cases awaiting private conversation synchronization.",
    registers: [registry],
  });
  const privateReady = new Gauge({
    name: "hearthkeeper_case_private_ready",
    help: "Whether configured private conversation parents pass permission checks.",
    registers: [registry],
  });
  const reviewDelivery=new Counter({name:'hearthkeeper_review_delivery_total',help:'Review notification delivery outcomes.',labelNames:['kind','outcome'],registers:[registry]});
  const reviewLag=new Histogram({name:'hearthkeeper_review_delivery_lag_seconds',help:'Delay from durable review update to Discord acknowledgement.',buckets:[1,5,15,30,60,120,300,900],registers:[registry]});
  const reviewPending=new Gauge({name:'hearthkeeper_review_pending_deliveries',help:'Review notifications awaiting delivery.',registers:[registry]});
  const reviewOldest=new Gauge({name:'hearthkeeper_review_oldest_pending_age_seconds',help:'Age of the oldest undelivered review update.',registers:[registry]});
  const reviewHealth=new Gauge({name:'hearthkeeper_review_last_poll_timestamp_seconds',help:'Last successful review queue read.',registers:[registry]});
  const updateDelivery=new Counter({name:'hearthkeeper_update_delivery_total',help:'Daily update digest delivery outcomes.',labelNames:['outcome'],registers:[registry]});
  const relayEvents=new Counter({name:'hearthkeeper_relay_events_total',help:'Mentions and replies to the bot handed to operators.',labelNames:['kind','outcome'],registers:[registry]});
  const relayPending=new Gauge({name:'hearthkeeper_relay_pending_events',help:'Relay events not yet acknowledged by the operators machine.',registers:[registry]});
  const relayOldest=new Gauge({name:'hearthkeeper_relay_oldest_pending_age_seconds',help:'Age of the oldest unacknowledged relay event.',registers:[registry]});
  const relayPull=new Gauge({name:'hearthkeeper_relay_last_pull_timestamp_seconds',help:'Last time the operators machine read relay events.',registers:[registry]});
  const relayFetch=new Counter({name:'hearthkeeper_relay_reference_fetch_total',help:'Reads of a replied-to message to tell whether it was the bot.',labelNames:['outcome'],registers:[registry]});
  const updateReport=new Counter({name:'hearthkeeper_update_report_total',help:'Shipped notes added to reports.',labelNames:['outcome'],registers:[registry]});
  reviewHealth.set(0);
  let ready = false;
  readyGauge.set(0);
  return {
    reviewMetrics:{
      record(kind:string,outcome:string,lag?:number){
        reviewDelivery.inc({kind:['main','reminder','digest'].includes(kind)?kind:'main',outcome:['sent','updated','suppressed','failed'].includes(outcome)?outcome:'failed'});
        if(lag!==undefined&&Number.isFinite(lag))reviewLag.observe(Math.max(0,lag));
      },
      health(count:number,oldest:number|null){reviewPending.set(count);reviewOldest.set(oldest===null?0:Math.max(0,(Date.now()-oldest)/1000));reviewHealth.set(Date.now()/1000);},
    },
    relayMetrics:{
      event(kind:string,outcome:string){relayEvents.inc({kind:['mention','reply','case-thread'].includes(kind)?kind:'mention',outcome:['queued','coalesced','rate_limited'].includes(outcome)?outcome:'queued'});},
      fetch(outcome:'success'|'failure'){relayFetch.inc({outcome});},
      pulled(pending:number,oldestAgeMs:number){relayPending.set(pending);relayOldest.set(oldestAgeMs/1000);relayPull.set(Date.now()/1000);},
      health(pending:number,oldestAgeMs:number){relayPending.set(pending);relayOldest.set(oldestAgeMs/1000);},
    },
    updateMetrics:{
      delivery(outcome:string){updateDelivery.inc({outcome:['sent','updated','deleted','failed','suppressed'].includes(outcome)?outcome:'failed'});},
      report(outcome:string){updateReport.inc({outcome:['delivered','missing','failed'].includes(outcome)?outcome:'failed'});},
    },
    recordCaseInteraction(kind: "command" | "button" | "modal", outcome: "success" | "failure" | "denied") {
      caseInteractions.inc({ kind, outcome });
    },
    recordPrivateDelivery(outcome: "success" | "failure" | "capacity") {
      privateDelivery.inc({ outcome });
    },
    setPrivateHealth(count: number, safe: boolean) {
      privatePending.set(count);
      privateReady.set(safe ? 1 : 0);
    },
    recordCommunity(outcome: string) {
      communitySync.inc({
        outcome: ["synced", "not_member", "denied", "failed"].includes(outcome)
          ? outcome
          : "failed",
      });
    },
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
        const language = userLanguage(input.locale);
        await input.reply(
          action === "menu"
            ? menu(language, config.site)
            : {
                content: localize(
                  language,
                  "我在這裡！",
                  "我在这里！",
                  "I'm here!",
                ),
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

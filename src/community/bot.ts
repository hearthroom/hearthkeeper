import { renderReviewNotice, renderReviewReminder, reviewNonce, type ReviewJob, type ReviewLocale } from './review-notice.js';
import {
  Client,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type Message,
  type Interaction,
  DiscordAPIError,
} from "discord.js";
import { createHash } from "node:crypto";
import type { CaseStore, CaseView } from "../cases/store.js";
import { CaseError } from "../cases/store.js";
import {
  CommunityStore,
  eligibleMessage,
  rolePlan,
  signedHeaders,
} from "./core.js";
export interface CommunityConfig {
  site: string;
  key: string;
  databasePath: string;
  channels: string[];
  roles: { id: string; level?: number; badge?: string; linked?: boolean }[];
  reviewChannel?: string;
  reviewV2?: boolean;
  reviewLocale?: ReviewLocale;
}
interface Projection {
  revision: string;
  xp: number;
  level: number;
  linked: boolean;
  cleanup: boolean;
  badges: string[];
  state: string;
  handle: string | null;
  version: string | null;
}
interface CaseJob {
  id: string;
  user: string;
  version: string;
  lease: string;
  expires: number;
  payload: {
    action: string;
    caseId?: string;
    version?: number;
    title?: string;
    body?: string;
    category?: string;
    offset?: number;
  };
}
export class CommunityBot {
  readonly store: CommunityStore;
  private running = false;
  constructor(
    readonly client: Client,
    readonly guild: string,
    readonly config: CommunityConfig,
    readonly staff: string[],
    readonly cases?: CaseStore,
    readonly privateParentId?: string,
    readonly record: (outcome: string) => void = () => {},
    readonly reviewMetrics: {record:(kind:string,outcome:string,lag?:number)=>void;health:(pending:number,oldest:number|null)=>void} = {record:()=>{},health:()=>{}},
  ) {
    this.store = new CommunityStore(config.databasePath);
  }
  async call<T>(op: string, value: Record<string, unknown> = {}): Promise<T> {
    const path = "/internal/community/" + op,
      body = JSON.stringify({ guild: this.guild, ...value });
    const r = await fetch(this.config.site + path, {
      method: "POST",
      redirect: "error",
      body,
      headers: signedHeaders(this.config.key, path, body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("community_request_failed");
    return (await r.json()) as T;
  }
  onMessage(m: Message) {
    const publicChannel =
      m.channel.type === ChannelType.GuildText &&
      !!m.channel
        .permissionsFor(m.guild!.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel);
    if (
      eligibleMessage(
        {
          guildId: m.guildId,
          channelId: m.channelId,
          author: m.author,
          webhookId: m.webhookId,
          system: m.system,
          type: m.type,
          channel: {
            isThread: () => m.channel.isThread(),
            public: publicChannel,
          },
        },
        this.guild,
        this.config.channels,
      )
    )
      this.store.enqueue({
        id: m.id,
        user: m.author.id,
        channel: m.channelId,
        time: m.createdTimestamp,
      });
  }
  async syncRoles(user: string) {
    const p = await this.call<Projection>("projection", { user });
    if (!p.revision) return;
    let state = "synced";
    let memberVerified = false;
    try {
      const guild = await this.client.guilds.fetch(this.guild),
        member = await guild.members.fetch({ user, force: true });
      memberVerified = true;
      if (p.linked && p.version) await this.call("appearance-sync", {
        user, version:p.version, observedAt:Date.now(), member:true,
        boostingSince:member.premiumSinceTimestamp,
        avatar:member.user.avatar, guildAvatar:member.avatar,
        decoration:member.user.avatarDecorationData?.asset ?? null,
        guildDecoration:member.avatarDecorationData?.asset ?? null,
      });
      const bot = await guild.members.fetchMe();
      const roles = await guild.roles.fetch(),
        channels = await guild.channels.fetch();
      const safety = this.config.roles.map((rule) => {
        const r = roles.get(rule.id);
        if (!r) throw new Error("role_denied");
        let allow = 0n;
        for (const c of channels.values())
          if (c && "permissionOverwrites" in c)
            allow |=
              c.permissionOverwrites.cache.get(r.id)?.allow.bitfield ?? 0n;
        return {
          id: r.id,
          position: r.position,
          managed: r.managed,
          permissions: r.permissions.bitfield,
          overwriteAllow: allow,
        };
      });
      if (
        !bot.permissions.has(PermissionFlagsBits.ManageRoles) &&
        this.config.roles.length
      )
        throw new Error("role_denied");
      const desired = this.config.roles
        .filter(
          (r) =>
            (r.level !== undefined && p.level >= r.level) ||
            (r.badge && p.badges.includes(r.badge)) ||
            (r.linked && p.linked),
        )
        .map((r) => r.id);
      const plan = rolePlan(
        safety,
        desired,
        [...member.roles.cache.keys()],
        this.store.owned(user),
        bot.roles.highest.position,
        this.staff,
      );
      for (const role of plan.remove) {
        const latest = await this.call<Projection>("projection", { user });
        if (latest.revision !== p.revision) return;
        await member.roles.remove(role);
        this.store.forget(user, role);
      }
      for (const role of plan.add) {
        const latest = await this.call<Projection>("projection", { user });
        if (latest.revision !== p.revision) return;
        this.store.own(user, role);
        await member.roles.add(role);
      }
      const actual = await guild.members.fetch({ user, force: true });
      if (
        desired.some((r) => !actual.roles.cache.has(r)) ||
        plan.remove.some((r) => actual.roles.cache.has(r))
      )
        throw new Error("role_readback");
    } catch (e) {
      state =
        e instanceof DiscordAPIError && e.code === 10007 && !memberVerified
          ? "not_member"
          : e instanceof Error && e.message === "role_denied"
            ? "denied"
            : "failed";
    }
    if (state === "not_member" && p.linked && p.version) await this.call("appearance-sync", {
      user,version:p.version,observedAt:Date.now(),member:false,boostingSince:null,
      avatar:null,guildAvatar:null,decoration:null,guildDecoration:null,
    });
    await this.call("ack", { user, revision: p.revision, state });
    this.record(state);
  }
  async caseJob(id: string) {
    const j = await this.call<CaseJob>("case-lease", { id });
    // A fresh lease proves current membership link and consent; CaseStore still enforces ownership.
    await this.call("case-check", { id, lease: j.lease });
    if (Date.now() >= j.expires) return;
    const actor = { guildId: this.guild, userId: j.user, staff: false };
    const b = j.payload;
    let result: unknown;
    const view = (c: CaseView) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      state: c.state,
      version: c.version,
      createdAt: c.createdAt,
      locked: c.locked,
      archived: c.archived,
      resolution: c.resolution,
      events: c.events
        .slice(-30)
        .map((e) => ({ kind: e.kind, body: e.body, seq: e.seq })),
      conversation: c.privateThreadId
        ? `https://discord.com/channels/${this.guild}/${c.privateThreadId}`
        : null,
    });
    try {
      if (!this.cases) throw new Error("unavailable");
      await (
        await this.client.guilds.fetch(this.guild)
      ).members.fetch({ user: j.user, force: true });
      await this.call("case-check", { id, lease: j.lease });
      if (Date.now() >= j.expires) return;
      if (b.action === "list")
        result = {
          items: this.cases.list(actor, b.offset ?? 0).map((c) => {
            const v = view(c);
            return { ...v, events: [] };
          }),
        };
      else if (b.action === "read")
        result = view(this.cases.read(actor, b.caseId!));
      else if (b.action === "create")
        result = view(
          this.cases.create(
            actor,
            {
              title: b.title!,
              body: b.body!,
              category: b.category!,
              mode: "identified",
              privateParentId: this.privateParentId,
            },
            "web:" + id,
          ),
        );
      else if (
        ["supplement", "request_close", "request_reopen"].includes(b.action)
      )
        result = view(
          this.cases.act(
            actor,
            b.caseId!,
            b.version!,
            b.action as "supplement" | "request_close" | "request_reopen",
            b.body ?? "",
            "web:" + id,
          ),
        );
      else throw new Error("denied");
    } catch (e) {
      result = { error: e instanceof CaseError ? e.message : "unavailable" };
    }
    await this.call("case-result", { id, lease: j.lease, result });
  }
  async notification(id: string) {
    const n = await this.call<{
      kind: string;
      path: string;
      discord_id: string;
    }>("notification", { id });
    if (!this.store.delivered(id)) {
      const user = await this.client.users.fetch(n.discord_id);
      const dm = await user.createDM();
      if(n.kind==='review_reminder') {
        const current=await this.call<{discord_id:string}>('notification',{id});
        if(current.discord_id!==n.discord_id) {this.reviewMetrics.record('reminder','suppressed');return;}
      }
      const message = await dm.send({
        content: n.kind === "review_reminder" ? renderReviewReminder(this.config.site,this.config.reviewLocale) : `HearthRoom 有新的社群通知 / You have a community update.\n<${this.config.site}/me>`,
        allowedMentions: { parse: [] },
        nonce: createHash("sha256").update(id).digest("hex").slice(0, 24),
        enforceNonce: true,
      });
      this.store.receipt(id, message.id);
    }
    await this.call("notification", { id, delivered: true });
    if(n.kind==='review_reminder')this.reviewMetrics.record('reminder','sent');
  }
  async reviewChannel() {
    if (!this.config.reviewChannel) throw new Error("review_channel_missing");
    const channel = await this.client.channels.fetch(this.config.reviewChannel);
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guildId !== this.guild ||
      channel
        .permissionsFor(channel.guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    )
      throw new Error("review_channel_denied");
    for (const o of channel.permissionOverwrites.cache.values())
      if (
        o.allow.has(PermissionFlagsBits.ViewChannel) &&
        o.id !== this.client.user!.id &&
        !this.staff.includes(o.id)
      )
        throw new Error("review_channel_denied");
    // A role with guild-level ViewChannel can inherit access without an explicit allow.
    const roles=await channel.guild.roles.fetch();
    for(const role of roles.values()) if(role && role.id!==channel.guild.id && !this.staff.includes(role.id)
      && !role.permissions.has(PermissionFlagsBits.Administrator) && role.tags?.botId!==this.client.user!.id && channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel))
      throw new Error('review_channel_denied');
    return channel;
  }
  async reviewDelivery(id:string) {
    const channel=await this.reviewChannel();
    const job=await this.call<ReviewJob>('review-project-v2',{id,channel:channel.id,lang:this.config.reviewLocale??'zh-Hant'});
    try {
      const payload=renderReviewNotice(job,this.config.site,this.config.reviewLocale);
      let message=null;
      const receiptKey='review-v2:'+channel.id+':'+id;
      const knownMessage=job.messageId??this.store.delivered(receiptKey);
      if(knownMessage) {
        try {message=await channel.messages.fetch(knownMessage);}
        catch(e){if(!(e instanceof DiscordAPIError && e.code===10008))throw e;}
      }
      // Recover a send whose success acknowledgement was lost, before creating another message.
      if(!message){
        const attempt=this.store.reviewAttempt(id,channel.id);
        let before:string|undefined, reachedBoundary=false;
        for(let page=0;page<5;page++){
          const recent=await channel.messages.fetch({limit:100,...(before?{before}:{})});
          const messages=[...recent.values()];
          message=messages.find(m=>m.author.id===this.client.user!.id && m.embeds[0]?.url===payload.embeds[0]!.url)??null;
          const oldest=messages.at(-1);
          if(message||messages.length<100||!attempt||(oldest&&oldest.createdTimestamp<attempt-5000)){reachedBoundary=true;break;}
          before=oldest?.id;
        }
        if(!message&&!reachedBoundary)throw new Error('review_send_uncertain');
      }
      if(message && message.author.id!==this.client.user!.id)throw new Error('review_message_denied');
      if(!(await this.call<{valid:boolean}>('review-check-v2',{id,lease:job.lease,revision:job.revision})).valid){
        await this.call('review-ack-v2',{id,lease:job.lease,revision:job.revision,failed:true});
        this.reviewMetrics.record(job.kind,'suppressed');return;
      }
      // Recheck destination permissions immediately before sending private workflow metadata.
      await this.reviewChannel();
      const existing=!!message;
      if(message)message=await message.edit({...payload,content:''});
      else {this.store.beginReviewAttempt(id,channel.id,Date.now());message=await channel.send({...payload,nonce:reviewNonce(id),enforceNonce:true});}
      // The API response is durable message readback, not a UI acceptance claim.
      this.store.receipt(receiptKey,message.id);
      this.store.finishReviewAttempt(id,channel.id);
      await this.call('review-ack-v2',{id,lease:job.lease,revision:job.revision,channel:channel.id,messageId:message.id});
      this.reviewMetrics.record(job.kind,existing?'updated':'sent',job.changed===false?undefined:Math.max(0,(Date.now()-job.updatedAt)/1000));
    }catch(error){
      this.reviewMetrics.record(job.kind,'failed');
      await this.call('review-ack-v2',{id,lease:job.lease,revision:job.revision,failed:true}).catch(()=>{});
      throw error;
    }
  }
  async reviewNotice(revision: string) {
    if (!this.config.reviewChannel) return;
    const channel=await this.reviewChannel();
    if (!this.store.delivered("review:" + revision)) {
      const m = await channel.send({
        content: `有新的待審作品 / New submissions await review.\n<${this.config.site}/review>`,
        allowedMentions: { parse: [] },
        nonce: createHash("sha256").update(revision).digest("hex").slice(0, 24),
        enforceNonce: true,
      });
      this.store.receipt("review:" + revision, m.id);
    }
    await this.call("review-ack", { revision });
  }
  async tick() {
    if (this.running || !this.client.isReady()) return;
    this.running = true;
    try {
      const events = this.store.pending();
      try {
        if (events.length) {
          const r = await this.call<{ receipts: { id: string }[] }>("events", {
            events,
          });
          for (const receipt of r.receipts) this.store.ack(receipt.id);
        }
      } catch {
        this.record("failed");
      }
      this.store.prune();
      const pending = await this.call<{
        subjects: string[];
        jobs: { id: string }[];
        notifications: { id: string }[];
        review: { revision: string } | null;
      }>("pending");
      for (const user of pending.subjects) await this.syncRoles(user);
      for (const job of pending.jobs)
        try {
          await this.caseJob(job.id);
        } catch {
          this.record("failed");
        }
      for (const n of pending.notifications)
        try {
          await this.notification(n.id);
        } catch {
          this.record("failed");
        }
      if (this.config.reviewV2 && this.config.reviewChannel) {
        try {
          const reviews=await this.call<{version:number;jobs:{id:string}[];pending:number;oldestAt:number|null}>('review-pending-v2');
          if(reviews.version!==2)throw new Error('review_version');
          this.reviewMetrics.health(reviews.pending,reviews.oldestAt);
          for(const job of reviews.jobs)try {await this.reviewDelivery(job.id);}catch {this.record('failed');}
        }catch {this.reviewMetrics.record('main','failed');}
      } else if (pending.review)
        try {
          await this.reviewNotice(pending.review.revision);
        } catch {
          this.record("denied");
        }
    } catch {
      this.record("failed");
    } finally {
      this.running = false;
    }
  }
  async handle(i: Interaction) {
    if (
      !i.isChatInputCommand() ||
      !["link", "level", "subscriptions", "xp", "card"].includes(i.commandName)
    )
      return false;
    if (
      i.guildId !== this.guild ||
      i.applicationId !== this.client.application?.id
    )
      return false;
    const zh = i.locale.startsWith("zh");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (i.commandName === "card") {
        const card = await this.call<{
          title: string;
          summary: string;
          url: string;
        }>("card", {
          card: i.options.getString("number", true),
          lang: zh ? "zh" : "en",
        });
        await i.editReply({
          embeds: [
            { title: card.title, description: card.summary, url: card.url },
          ],
          allowedMentions: { parse: [] },
        });
        return true;
      }
      if (i.commandName === "xp") {
        await this.call("xp-preference", {
          user: i.user.id,
          enabled: i.options.getBoolean("enabled", true),
        });
      }
      const p = await this.call<Projection>("projection", { user: i.user.id });
      const labels: Record<string, string> = {
        unlinked: "尚未綁定",
        pending: "同步中",
        synced: "已同步",
        not_member: "尚未加入社群",
        denied: "身分組權限待確認",
        failed: "同步失敗，稍後重試",
        cleanup: "解除綁定清理中",
      };
      await i.editReply({
        content: zh
          ? `**HearthRoom 社群**\n${labels[p.state] ?? "待確認"} · 等級 ${p.level} · ${p.xp} XP\n每 60 秒最多 1 XP，每日最多 60 XP。使用 /xp 可停止或恢復計分。`
          : `**HearthRoom community**\n${p.state} · Level ${p.level} · ${p.xp} XP\nAt most 1 XP per 60 seconds and 60 XP per day. Use /xp to pause or resume.`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: zh ? "我的社群與通知" : "My community and notifications",
                url: this.config.site + "/me",
              },
              ...(p.handle
                ? [
                    {
                      type: 2 as const,
                      style: 5 as const,
                      label: zh ? "我的個人頁" : "My profile",
                      url: this.config.site + "/authors/" + p.handle,
                    },
                  ]
                : []),
            ],
          },
        ],
        allowedMentions: { parse: [] },
      });
    } catch {
      await i.editReply(
        zh
          ? "暫時無法讀取社群資料，請稍後重試。"
          : "Community data is temporarily unavailable. Please try again.",
      );
    }
    return true;
  }
}

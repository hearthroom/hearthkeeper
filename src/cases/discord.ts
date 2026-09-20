import {
  Client,
  ChannelType,
  type ForumChannel,
  type ThreadChannel,
} from "discord.js";
import {
  CaseStore,
  type Actor,
  type CaseView,
  type CaseEvent,
} from "./store.js";
import { checkForumAccess } from "./policy.js";
import { CaseInteractions, forumContent } from "./interactions.js";
import type { Transport } from "./delivery.js";
export interface CaseConfig {
  forumId: string;
  staffRoleIds: string[];
  databasePath: string;
  key: string;
  lookupKey: string;
}
export class DiscordCases implements Transport {
  readonly ui: CaseInteractions;
  constructor(
    private client: Client,
    private guildId: string,
    private appId: string,
    private config: CaseConfig,
    store: CaseStore,
  ) {
    this.ui = new CaseInteractions(store, guildId, appId, (i) => this.actor(i));
  }
  private async guild() {
    return await this.client.guilds.fetch(this.guildId);
  }
  async actor(i: any): Promise<Actor> {
    const guild = await this.guild();
    const member = await guild.members.fetch({ user: i.user.id, force: true });
    return {
      guildId: guild.id,
      userId: member.id,
      staff:
        member.id === guild.ownerId ||
        this.config.staffRoleIds.some((id) => member.roles.cache.has(id)),
    };
  }
  private async forum() {
    const c = await this.client.channels.fetch(this.config.forumId, {
      force: true,
    });
    if (!c || c.type !== ChannelType.GuildForum || c.guildId !== this.guildId)
      throw new Error("forum_invalid");
    return c as ForumChannel;
  }
  async verify() {
    const f = await this.forum();
    await f.guild.roles.fetch();
    const me = await f.guild.members.fetchMe({ force: true });
    if (
      !checkForumAccess({
        guildId: this.guildId,
        forumGuildId: f.guildId,
        type: f.type,
        botId: me.id,
        staffRoles: this.config.staffRoleIds,
        botPermissions: f.permissionsFor(me)?.bitfield ?? 0n,
        overwrites: f.permissionOverwrites.cache.map((o) => ({
          id: o.id,
          type: o.type,
          allow: o.allow.bitfield.toString(),
          deny: o.deny.bitfield.toString(),
        })),
      })
    )
      throw new Error("forum_unsafe");
  }
  private async thread(id: string) {
    const c = await this.client.channels.fetch(id, { force: true });
    if (
      !c?.isThread() ||
      c.parentId !== this.config.forumId ||
      c.guildId !== this.guildId ||
      c.ownerId !== this.appId
    )
      throw new Error("thread_invalid");
    return c as ThreadChannel;
  }
  async findThread(id: string) {
    const f = await this.forum();
    const match = (t: ThreadChannel) =>
      t.name === `HK-${id}` && t.ownerId === this.appId && t.parentId === f.id;
    const active = await f.threads.fetchActive();
    const found = active.threads.find(match);
    if (found) return found.id;
    let before: Date | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await f.threads.fetchArchived({
        type: "public",
        limit: 100,
        ...(before ? { before } : {}),
      });
      const found = result.threads.find(match);
      if (found) return found.id;
      if (!result.hasMore) return null;
      const last = result.threads.last();
      if (!last?.archiveTimestamp) throw new Error("readback_incomplete");
      before = new Date(last.archiveTimestamp);
    }
    throw new Error("readback_incomplete");
  }
  async createThread(c: CaseView, e: CaseEvent) {
    const f = await this.forum();
    const t = await f.threads.create({
      name: `HK-${c.id}`,
      autoArchiveDuration: 1440,
      message: {
        embeds: [{ title: c.title, description: forumContent(c, e) }],
        components: this.ui.staffPanel(c),
        allowedMentions: { parse: [] },
      },
    });
    return t.id;
  }
  async findMessage(id: string, key: string) {
    const t = await this.thread(id);
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const messages = await t.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });
      const found = messages.find(
        (m) =>
          m.author.id === this.appId &&
          m.embeds.some((e) => e.description?.includes(`hk:${key}`)),
      );
      if (found) return found.id;
      if (messages.size < 100) return null;
      before = messages.last()?.id;
    }
    throw new Error("readback_incomplete");
  }
  async sendEvent(id: string, c: CaseView, e: CaseEvent) {
    const t = await this.thread(id);
    if (t.locked || t.archived)
      await t.edit({ locked: false, archived: false });
    const m = await t.send({
      embeds: [{ description: forumContent(c, e) }],
      allowedMentions: { parse: [] },
    });
    return m.id;
  }
  async sync(c: CaseView) {
    if (!c.threadId) throw new Error("thread_missing");
    const t = await this.thread(c.threadId);
    if (t.locked || t.archived)
      await t.edit({ locked: false, archived: false });
    const starter = await t.fetchStarterMessage();
    if (!starter || starter.author.id !== this.appId)
      throw new Error("starter_missing");
    await starter.edit({
      components: this.ui.staffPanel(c),
      allowedMentions: { parse: [] },
    });
    const closed = c.state === "closed";
    await t.edit({ locked: closed, archived: closed });
    const readback = await this.thread(t.id);
    if (readback.locked !== closed || readback.archived !== closed)
      throw new Error("state_readback_failed");
  }
  async remove(id: string) {
    try {
      const t = await this.thread(id);
      await t.delete();
    } catch (e) {
      if ((e as { code?: number }).code !== 10003) throw e;
    }
  }
}

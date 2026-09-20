import {
  categories,
  caseTagNames,
  statusLabels,
  statusEmojiNames,
  type StatusCase,
} from "./catalog.js";
import {
  Client,
  ChannelType,
  MessageFlags,
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
  privateParentId?: string;
  privateMaxActive?: number;
  staffRoleIds: string[];
  databasePath: string;
  key: string;
  lookupKey: string;
}
export class DiscordCases implements Transport {
  readonly ui: CaseInteractions;
  private emojis = new Map<
    string,
    { id: string; name: string; animated: boolean }
  >();
  private reconcileCursor = "";
  constructor(
    private client: Client,
    private guildId: string,
    private appId: string,
    private config: CaseConfig,
    private store: CaseStore,
    observe?: (kind: "command" | "button" | "modal", outcome: "success" | "failure" | "denied") => void,
  ) {
    this.ui = new CaseInteractions(
      store,
      guildId,
      appId,
      (i) => this.actor(i),
      (name) => this.emojis.get(name),
      config.privateParentId,
      observe,
    );
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
  async onStaffMessage(message: any) {
    // Only metadata is used; never read, retain, or log message content/attachments.
    if (
      message.guildId !== this.guildId ||
      message.author?.bot ||
      message.webhookId ||
      ![0, 19].includes(message.type)
    )
      return false;
    const privateId = this.store.privateCaseForThread(message.channelId);
    const caseId =
      message.channel?.parentId === this.config.forumId
        ? this.store.caseForThread(message.channelId)
        : privateId &&
            this.store.privateProjection(privateId)?.parentId ===
              message.channel?.parentId
          ? privateId
          : undefined;
    if (!caseId) return false;
    const actor = await this.actor({ user: message.author });
    if (!actor.staff) return false;
    const c = this.store.read(actor, caseId);
    if (
      [
        "closed",
        "in_progress",
        "waiting_technical",
        "under_discussion",
      ].includes(c.state)
    )
      return false;
    this.store.act(
      actor,
      c.id,
      c.version,
      "set_processing",
      "社管已在案件對話回覆。",
      "message:" + message.id,
    );
    return true;
  }
  async onThreadUpdate(event: {
    id: string;
    guildId: string;
    parentId: string | null;
  }) {
    if (
      event.guildId !== this.guildId ||
      event.parentId !== this.config.forumId
    )
      return false;
    const id = this.store.caseForThread(event.id);
    if (!id) return false;
    const c = this.store.projection(id);
    // Our worker always writes while a projection is pending. Ignore its temporary unlocks.
    if (c.sync !== "synced") return false;
    const current = await this.thread(event.id);
    return this.store.observeThread(id, c.version, {
      archived: !!current.archived,
      locked: !!current.locked,
    });
  }
  async reconcileThreads() {
    const batch = this.store.settledThreads(this.reconcileCursor);
    let failed = false;
    for (const c of batch) {
      this.reconcileCursor = c.id;
      try {
        await this.onThreadUpdate({
          id: c.threadId!,
          guildId: this.guildId,
          parentId: this.config.forumId,
        });
      } catch {
        failed = true;
      }
    }
    if (batch.length < 20) this.reconcileCursor = "";
    if (failed) throw new Error("thread_reconcile_failed");
  }
  private async forum() {
    const c = await this.client.channels.fetch(this.config.forumId, {
      force: true,
    });
    if (!c || c.type !== ChannelType.GuildForum || c.guildId !== this.guildId)
      throw new Error("forum_invalid");
    return c as ForumChannel;
  }
  private tags(f: ForumChannel, c: StatusCase) {
    return caseTagNames(c.category, c.state, c).map((name) => {
      const tag = f.availableTags.find((t) => t.name === name);
      if (!tag) throw new Error("tags_missing");
      return tag.id;
    });
  }
  async verify() {
    const f = await this.forum();
    await f.guild.roles.fetch();
    const me = await f.guild.members.fetchMe({ force: true });
    const emojis = await f.guild.emojis.fetch();
    const resolved = new Map<
      string,
      { id: string; name: string; animated: boolean }
    >();
    for (const [state, name] of Object.entries(statusEmojiNames)) {
      const matches = emojis.filter(
        (e) =>
          e.name === name &&
          e.available &&
          (!e.roles.cache.size ||
            e.roles.cache.some((r) => me.roles.cache.has(r.id))),
      );
      if (matches.size !== 1) throw new Error("status_emoji_unavailable");
      const emoji = matches.first()!;
      const tag = f.availableTags.find((t) => t.name === statusLabels[state]);
      if (!tag || tag.emoji?.id !== emoji.id)
        throw new Error("status_tag_emoji_mismatch");
      resolved.set(name, { id: emoji.id, name, animated: !!emoji.animated });
    }
    this.emojis = resolved;
    // Validate before the outbox marks any send ambiguous.
    for (const category of categories)
      this.tags(f, { category: category.id, state: "submitted" });
    for (const name of Object.values(statusLabels))
      if (!f.availableTags.some((t) => t.name === name))
        throw new Error("tags_missing");
    const canMention = f.permissionsFor(me)?.has("MentionEveryone");
    if (
      !canMention &&
      this.config.staffRoleIds.some(
        (id) => !f.guild.roles.cache.get(id)?.mentionable,
      )
    )
      throw new Error("staff_mentions_unavailable");
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
    const match = async (t: ThreadChannel) => {
      if (t.ownerId !== this.appId || t.parentId !== f.id) return false;
      const starter = await t.fetchStarterMessage();
      return (
        starter?.author.id === this.appId &&
        starter.components.some(
          (row) =>
            "components" in row &&
            row.components.some(
              (component) =>
                "customId" in component &&
                typeof component.customId === "string" &&
                this.store.hasStaffAction(id, component.customId),
            ),
        )
      );
    };
    const active = await f.threads.fetchActive();
    for (const t of active.threads.values()) if (await match(t)) return t.id;
    let before: Date | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await f.threads.fetchArchived({
        type: "public",
        limit: 100,
        ...(before ? { before } : {}),
      });
      for (const t of result.threads.values()) if (await match(t)) return t.id;
      if (!result.hasMore) return null;
      const last = result.threads.last();
      if (!last?.archiveTimestamp) throw new Error("readback_incomplete");
      before = new Date(last.archiveTimestamp);
    }
    throw new Error("readback_incomplete");
  }
  private starterContent(c: CaseView, e: CaseEvent) {
    return (
      forumContent(c, e) +
      "\n\n" +
      this.config.staffRoleIds.map((id) => `<@&${id}>`).join(" ")
    );
  }
  async createThread(c: CaseView, e: CaseEvent) {
    const f = await this.forum();
    const t = await f.threads.create({
      name: c.title,
      autoArchiveDuration: 1440,
      appliedTags: this.tags(f, c),
      message: {
        content: this.starterContent(c, e),
        flags: MessageFlags.SuppressEmbeds,
        components: this.ui.staffPanel(c),
        allowedMentions: { parse: [], roles: this.config.staffRoleIds },
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
    const content = this.starterContent(c, c.events[0]!);
    await starter.edit({
      ...(starter.content !== content || starter.embeds.length
        ? { content, embeds: [], flags: MessageFlags.SuppressEmbeds }
        : {}),
      components: this.ui.staffPanel(c),
      allowedMentions: { parse: [] },
    });
    const appliedTags = this.tags(await this.forum(), c);
    await t.edit({
      name: c.title,
      locked: c.locked,
      archived: c.archived,
      appliedTags,
    });
    const readback = await this.thread(t.id);
    if (
      readback.name !== c.title ||
      readback.locked !== c.locked ||
      readback.archived !== c.archived ||
      appliedTags.some((id) => !readback.appliedTags.includes(id)) ||
      readback.appliedTags.length !== appliedTags.length
    )
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

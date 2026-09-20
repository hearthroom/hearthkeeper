import {
  Client,
  ChannelType,
  PermissionFlagsBits as P,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  CaseStore,
  CaseView,
  CaseEvent,
  PrivateProjection,
} from "./store.js";
import { CaseInteractions, forumContent, stateName } from "./interactions.js";
import { caseStatus } from "./catalog.js";
import type { PrivateTransport } from "./private-delivery.js";
const memberAllow =
  P.ViewChannel |
  P.SendMessagesInThreads |
  P.AttachFiles |
  P.ReadMessageHistory;
const memberDeny =
  P.SendMessages |
  P.CreatePublicThreads |
  P.CreatePrivateThreads |
  P.ManageThreads;
const botRequired =
  memberAllow |
  P.SendMessages |
  P.CreatePrivateThreads |
  P.ManageThreads |
  P.EmbedLinks;
export function checkPrivateParentAccess(
  guild: string,
  bot: string,
  staff: string[],
  parent: TextChannel,
) {
  if (
    parent.type !== ChannelType.GuildText ||
    parent.guildId !== guild ||
    !staff.length
  )
    return false;
  const overwrites = [...parent.permissionOverwrites.cache.values()];
  const everyone = overwrites.find((o) => o.id === guild && o.type === 0);
  if (
    !everyone ||
    (everyone.allow.bitfield & memberAllow) !== memberAllow ||
    (everyone.deny.bitfield & memberDeny) !== memberDeny ||
    (everyone.allow.bitfield & memberDeny) !== 0n
  )
    return false;
  return overwrites.every(
    (o) =>
      (o.allow.bitfield & memberDeny) === 0n ||
      (o.type === 0 && staff.includes(o.id)) ||
      (o.type === 1 && o.id === bot),
  );
}
export class DiscordPrivateCases implements PrivateTransport {
  private cursor = "";
  constructor(
    private client: Client,
    private guildId: string,
    private appId: string,
    private staffRoles: string[],
    private maxActive: number,
    private ui: CaseInteractions,
  ) {}
  private async parent(id: string) {
    const p = await this.client.channels.fetch(id, { force: true });
    if (!p || p.type !== ChannelType.GuildText || p.guildId !== this.guildId)
      throw Error("private_parent_invalid");
    return p;
  }
  async verify(id: string) {
    const p = await this.parent(id);
    if (!checkPrivateParentAccess(this.guildId, this.appId, this.staffRoles, p))
      throw Error("private_parent_unsafe");
    const roles = await p.guild.roles.fetch();
    const me = await p.guild.members.fetchMe({ force: true });
    if (!p.permissionsFor(me)?.has(botRequired))
      throw Error("private_bot_permissions");
    for (const id of this.staffRoles) {
      const role = roles.get(id);
      if (!role || !p.permissionsFor(role)?.has(memberAllow | P.ManageThreads))
        throw Error("private_staff_permissions");
    }
  }
  private async thread(parent: string, id: string) {
    const t = await this.client.channels.fetch(id, { force: true });
    if (
      !t ||
      t.type !== ChannelType.PrivateThread ||
      t.guildId !== this.guildId ||
      t.parentId !== parent ||
      t.ownerId !== this.appId
    )
      throw Error("private_thread_invalid");
    return t as ThreadChannel;
  }
  async canCreate(parent: string) {
    const p = await this.parent(parent);
    const active = await p.guild.channels.fetchActiveThreads();
    // Conservative guild-wide budget, not an assumption about Discord's maximum.
    return active.threads.size < this.maxActive;
  }
  async createThread(p: PrivateProjection) {
    const parent = await this.parent(p.parentId);
    const t = await parent.threads.create({
      name: "hk-pending-" + p.caseId,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 1440,
    });
    // No identity or content is posted until the external ID is durably stored.
    return t.id;
  }
  async findThread(p: PrivateProjection) {
    const parent = await this.parent(p.parentId);
    const match = (t: ThreadChannel) =>
      t.name === "hk-pending-" + p.caseId &&
      t.ownerId === this.appId &&
      t.parentId === parent.id &&
      t.type === ChannelType.PrivateThread;
    const active = await parent.threads.fetchActive();
    const found = active.threads.filter(match);
    if (found.size > 1) throw Error("private_create_ambiguous");
    if (found.size === 1) return found.first()!.id;
    let before: Date | undefined;
    for (let page = 0; page < 20; page++) {
      const archived = await parent.threads.fetchArchived({
        type: "private",
        limit: 100,
        ...(before ? { before } : {}),
      });
      const matches = archived.threads.filter(match);
      if (matches.size > 1) throw Error("private_create_ambiguous");
      if (matches.size === 1) return matches.first()!.id;
      if (!archived.hasMore) return null;
      const last = archived.threads.last();
      if (!last?.archiveTimestamp) throw Error("private_readback_incomplete");
      before = new Date(last.archiveTimestamp);
    }
    throw Error("private_readback_incomplete");
  }
  async findMessage(p: PrivateProjection, key: string) {
    const t = await this.thread(p.parentId, p.threadId!);
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const messages = await t.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });
      const found = messages.find(
        (m) =>
          m.author.id === this.appId &&
          m.embeds.some((e) => e.footer?.text === "hk-private:" + key),
      );
      if (found) return found.id;
      if (messages.size < 100) return null;
      before = messages.last()?.id;
    }
    throw Error("private_readback_incomplete");
  }
  private async writable(p: PrivateProjection) {
    const t = await this.thread(p.parentId, p.threadId!);
    if (t.invitable !== false || t.archived || t.locked)
      await t.edit({ invitable: false, archived: false, locked: false });
    return t;
  }
  async sendEvent(p: PrivateProjection, c: CaseView, e: CaseEvent) {
    if (c.mode !== "identified" || !c.reporter)
      throw Error("private_identity_required");
    const t = await this.writable(p);
    const m = await t.send({
      content: e.seq === 1 ? forumContent(c, e) : undefined,
      embeds: [
        {
          ...(e.seq === 1 ? {} : { description: forumContent(c, e) }),
          footer: { text: "hk-private:" + e.deliveryKey },
        },
      ],
      components: e.seq === 1 ? this.ui.staffPanel(c) : [],
      allowedMentions: { parse: [] },
    });
    return m.id;
  }
  async sync(p: PrivateProjection, c: CaseView) {
    if (c.mode !== "identified" || !c.reporter)
      throw Error("private_identity_required");
    const parent = await this.parent(p.parentId);
    const owner = await parent.guild.members.fetch({
      user: c.reporter,
      force: true,
    });
    if (!parent.permissionsFor(owner)?.has(memberAllow))
      throw Error("private_reporter_permissions");
    const t = await this.writable(p);
    const first = p.events.find((e) => e.seq === 1);
    if (!first?.externalId) throw Error("private_starter_missing");
    const starter = await t.messages.fetch(first.externalId);
    if (starter.author.id !== this.appId)
      throw Error("private_starter_invalid");
    await starter.edit({
      content:
        forumContent(c, first) +
        "\n\n狀態：" +
        stateName(caseStatus(c)) +
        "\n你可以在這裡與社管交談、傳附件；正式補充與處理結果請使用案件選單。",
      embeds: [{ footer: { text: "hk-private:" + first.deliveryKey } }],
      components: this.ui.staffPanel(c),
      allowedMentions: { parse: [] },
    });
    await t.edit({ name: c.title, invitable: false });
    if ((await this.thread(p.parentId, t.id)).name !== c.title)
      throw Error("private_title_readback");
    await t.members.add(c.reporter);
    const membership = await t.members.fetch({
      member: c.reporter,
      force: true,
    });
    if (membership.id !== c.reporter)
      throw Error("private_membership_readback");
    await this.settle(p, c);
  }
  async settle(p: PrivateProjection, c: CaseView) {
    const t = await this.thread(p.parentId, p.threadId!);
    if (
      t.locked !== c.locked ||
      t.archived !== c.archived ||
      t.invitable !== false
    )
      await t.edit({
        locked: c.locked,
        archived: c.archived,
        invitable: false,
      });
    const read = await this.thread(p.parentId, t.id);
    if (
      read.locked !== c.locked ||
      read.archived !== c.archived ||
      read.invitable !== false
    )
      throw Error("private_state_readback");
  }
  async reconcile(store: CaseStore) {
    const batch = store.privateSettled(this.cursor);
    for (const p of batch) {
      this.cursor = p.caseId;
      const c = store.projection(p.caseId);
      const t = await this.thread(p.parentId, p.threadId!);
      // Idle auto-archive is not a case closure and need not be undone.
      if (
        t.locked !== c.locked ||
        (c.archived && !t.archived) ||
        t.invitable !== false ||
        t.name !== c.title
      )
        store.privateDirty(c.id);
    }
    if (batch.length < 20) this.cursor = "";
  }
  async remove(parent: string, id: string) {
    try {
      await (await this.thread(parent, id)).delete();
    } catch (e) {
      if ((e as { code?: number }).code !== 10003) throw e;
    }
  }
}

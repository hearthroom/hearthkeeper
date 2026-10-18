import { ChannelType, type Message } from "discord.js";
import { relayKind, type RelayInput } from "./core.js";

export interface RelayContext {
  guildId: string;
  botId: string;
  staffRoleIds: string[];
  forumId?: string;
  privateCaseThread: (threadId: string) => boolean;
  /** Whether a bot message is one of its daily update digests. */
  digestMessage: (messageId: string) => boolean;
  recordFetch: (outcome: "success" | "failure") => void;
}

const link = (guild: string, channel: string, message: string) =>
  `https://discord.com/channels/${guild}/${channel}/${message}`;

// Remembers who wrote recently replied-to messages so a reply costs at most one REST read.
const replied = new Map<string, { author: string | null; at: number }>();

async function repliedAuthor(m: Message, ctx: RelayContext) {
  const ref = m.reference?.messageId;
  if (!ref || m.type !== 19) return null;
  if (m.mentions.repliedUser) return m.mentions.repliedUser.id;
  const now = Date.now();
  for (const [k, v] of replied) if (v.at < now - 600_000) replied.delete(k);
  const known = replied.get(ref);
  if (known) return known.author;
  try {
    const target = await m.channel.messages.fetch(ref);
    ctx.recordFetch("success");
    replied.set(ref, { author: target.author.id, at: now });
    return target.author.id;
  } catch {
    // Not cached: a passing failure must not hide later replies to the same message.
    ctx.recordFetch("failure");
    return null;
  }
}

/** Metadata about a message worth relaying, or null. Never reads message content. */
export async function relayInput(m: Message, ctx: RelayContext): Promise<RelayInput | null> {
  if (m.guildId !== ctx.guildId || m.author.bot || m.webhookId || m.system) return null;
  const thread = m.channel.isThread() ? m.channel : null;
  const forumThread = !!thread && !!ctx.forumId && thread.parentId === ctx.forumId;
  const privateCaseThread =
    !!thread &&
    thread.type === ChannelType.PrivateThread &&
    thread.ownerId === ctx.botId &&
    ctx.privateCaseThread(thread.id);
  const botRole = m.guild?.members.me?.roles.botRole?.id;
  const mentionsBot =
    m.mentions.users.has(ctx.botId) || (!!botRole && m.mentions.roles.has(botRole));
  const repliedAuthorId = await repliedAuthor(m, ctx);
  const authorStaff =
    privateCaseThread && !!m.member && ctx.staffRoleIds.some((id) => m.member!.roles.cache.has(id));
  const kind = relayKind(
    {
      guildId: m.guildId,
      botId: ctx.botId,
      author: { id: m.author.id, bot: m.author.bot },
      webhookId: m.webhookId,
      system: m.system,
      type: m.type,
      mentionsBot,
      repliedAuthorId,
      privateCaseThread,
      forumThread,
      authorStaff,
    },
    ctx.guildId,
  );
  if (!kind) return null;
  const channelName = thread
    ? `${thread.parent?.name ?? "?"} / ${thread.name}`
    : "name" in m.channel
      ? (m.channel.name ?? "?")
      : "?";
  const ref = m.reference?.messageId;
  return {
    kind,
    authorId: m.author.id,
    channelId: m.channelId,
    channelName,
    messageLink: link(ctx.guildId, m.channelId, m.id),
    ...(kind === "reply" && ref
      ? { replyTo: link(ctx.guildId, m.channelId, ref), replyToDigest: ctx.digestMessage(ref) }
      : {}),
  };
}

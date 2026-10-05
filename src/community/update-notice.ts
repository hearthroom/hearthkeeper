import { createHash } from "node:crypto";

/**
 * Daily "what changed" digests posted to public announcement channels.
 *
 * The website owns the words: every heading, item title and URL arrives already written in the
 * channel's language, so this file only lays them out. Item titles come from the website's own
 * release notes, but they are still escaped and stripped of mentions, because a public channel is
 * the last place a stray `@everyone` or broken markdown link should land.
 */
export const updateLocales = ["zh-Hant", "zh-Hans", "en", "ja", "ko"] as const;
export type UpdateLocale = (typeof updateLocales)[number];
export type UpdateChannels = Partial<Record<UpdateLocale, string[]>>;

export interface UpdateItem {
  tier?: "highlight" | "feature";
  title: string;
  url: string;
}
export interface UpdateDigest {
  heading: string;
  url: string;
  items: UpdateItem[];
  fixesHeading: string;
  fixes: UpdateItem[];
  moreLabel: string;
  moreUrl: string;
}
export interface UpdateJob {
  day: string;
  locale: string;
  revision: number;
  lease: string;
  messageId: string | null;
  digest: UpdateDigest;
}

/**
 * `COMMUNITY_UPDATES_CHANNELS="zh-Hans:<notice board id>,zh-Hans:<lobby id>,en:<channel id>"`.
 * Absent or blank turns the digests off. A language may list several channels (posted in that
 * order); a channel appears once and serves one language, so a misconfiguration can never post
 * the same day twice into one place.
 */
export function parseUpdateChannels(raw: string | undefined): UpdateChannels | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const out: UpdateChannels = {};
  const seen = new Set<string>();
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    const match = /^([A-Za-z-]+):(\d{17,20})$/.exec(part);
    if (!match) throw new Error("Invalid COMMUNITY_UPDATES_CHANNELS");
    const locale = match[1] as UpdateLocale,
      channel = match[2]!;
    if (!updateLocales.includes(locale) || seen.has(channel))
      throw new Error("Invalid COMMUNITY_UPDATES_CHANNELS");
    (out[locale] ??= []).push(channel);
    seen.add(channel);
  }
  if (!Object.keys(out).length) throw new Error("Invalid COMMUNITY_UPDATES_CHANNELS");
  return out;
}

const CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;
/** Plain text for a Discord embed title: no control characters, no mentions. */
export function plainUpdateText(value: string, max = 256): string {
  return String(value).replace(CONTROL, " ").replace(/@/g, "＠").trim().slice(0, max);
}
/** Text that sits inside markdown (link labels, bold headings). */
export function markdownUpdateText(value: string, max = 300): string {
  return plainUpdateText(value, max).replace(/([\\*_~`|>[\]()])/g, "\\$1");
}
/** Only absolute https links without whitespace survive; `)` would close the markdown link early. */
export function safeUpdateUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^https:\/\/[^\s<>"]+$/.test(value)) return null;
  try {
    return new URL(value).protocol === "https:" ? value.replace(/\(/g, "%28").replace(/\)/g, "%29") : null;
  } catch {
    return null;
  }
}

/** Discord allows 4096; leave headroom so an edit with a longer revision never fails on size. */
const DESCRIPTION_LIMIT = 3900;

export function renderUpdateDigest(d: UpdateDigest) {
  const link = (i: UpdateItem) => {
    const url = safeUpdateUrl(i.url);
    const title = markdownUpdateText(i.title);
    return url ? `[${title}](${url})` : title;
  };
  const moreUrl = safeUpdateUrl(d.moreUrl);
  const more = moreUrl ? `[${markdownUpdateText(d.moreLabel, 80)}](${moreUrl})` : "";
  const lines: string[] = [];
  let used = more.length + 2;
  const push = (line: string) => {
    // Never cut a line in half: a half link renders as raw markdown in a public channel.
    if (used + line.length + 1 > DESCRIPTION_LIMIT) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };
  for (const item of d.items) if (!push((item.tier === "highlight" ? "✦ " : "・") + link(item))) break;
  if (d.fixes.length && push("") && push(`**${markdownUpdateText(d.fixesHeading, 80)}**`))
    for (const fix of d.fixes) if (!push("・" + link(fix))) break;
  if (more) lines.push("", more);
  const url = safeUpdateUrl(d.url);
  return {
    allowedMentions: { parse: [] as never[] },
    embeds: [
      {
        title: plainUpdateText(d.heading),
        ...(url ? { url } : {}),
        description: lines.join("\n"),
        color: 0xef4f6f,
      },
    ],
  };
}

export function updateNonce(day: string, locale: string, revision: number): string {
  return createHash("sha256").update(`update:${day}:${locale}:${revision}`).digest("hex").slice(0, 24);
}

/**
 * The line added to a report when the change it asked for ships. The case has no language of its
 * own, so it carries Traditional Chinese and English like the rest of the case workflow.
 */
export function renderShippedNote(titles: Record<string, unknown>, url: unknown): string {
  const zh = typeof titles["zh-Hant"] === "string" ? plainUpdateText(titles["zh-Hant"] as string, 200) : "";
  const en = typeof titles.en === "string" ? plainUpdateText(titles.en as string, 300) : "";
  const link = safeUpdateUrl(url);
  const lines = [
    zh ? `這則回報相關的更新已經上線：${zh}` : "這則回報相關的更新已經上線。",
    en ? `An update related to this report is now live: ${en}` : "An update related to this report is now live.",
  ];
  if (link) lines.push(link);
  return lines.join("\n").slice(0, 1400);
}

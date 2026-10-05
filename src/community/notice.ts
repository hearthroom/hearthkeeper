/**
 * Member notifications delivered as Discord DMs.
 *
 * The website bridge hands over the destination path and the sentence to show, already in the
 * member's interface language (or Traditional Chinese + English when it has none). The website
 * writes the same sentence for the bell and browser push, so it names the card, the person and
 * the review verdict; the bot does not keep its own copy of those sentences.
 *
 * When the sentence is missing (an older website build), the DM falls back to a generic line.
 * Card and member names are user-written, so markdown in the sentence is escaped.
 */
export const noticeLocales = ['zh-Hant', 'zh-Hans', 'en', 'ja', 'ko'] as const;
export type NoticeLocale = (typeof noticeLocales)[number];
const generic: Record<NoticeLocale, string> = {
 'zh-Hant': 'HearthRoom 有新的通知。',
 'zh-Hans': 'HearthRoom 有新的通知。',
 en: 'You have a new notification on HearthRoom.',
 ja: 'HearthRoom に新しいお知らせがあります。',
 ko: 'HearthRoom에 새 알림이 있습니다.',
};
const FALLBACK_PATH = '/me/community';
const MAX_TEXT = 400;
/** A website-relative path: one leading slash, no scheme, host, whitespace or control characters. */
export function safeNoticePath(path: unknown): string {
 return typeof path === 'string' && /^\/(?!\/)[\x21-\x7e]*$/.test(path) ? path : FALLBACK_PATH;
}
/** One line of plain text: control characters become spaces and markdown cannot apply. */
function plain(text: string): string {
 return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT).replace(/([\\*_~`|[\]<>#])/g, '\\$1');
}
export function renderCommunityNotice(text: unknown, path: unknown, site: string, locale?: unknown): string {
 const line = typeof text === 'string' && text.trim()
  ? plain(text)
  : noticeLocales.includes(locale as NoticeLocale)
   ? generic[locale as NoticeLocale]
   : generic['zh-Hant'] + ' / ' + generic.en;
 return line + '\n<' + site + safeNoticePath(path) + '>';
}

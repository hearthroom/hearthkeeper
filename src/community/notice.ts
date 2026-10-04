/**
 * Member notifications delivered as Discord DMs.
 *
 * The website bridge hands over the notification kind, the destination path and, once the
 * website records it, the member's interface language. The DM says what happened in that
 * language and links straight to the destination. Without a language the DM stays bilingual
 * (Traditional Chinese + English), which is what every DM looked like before.
 *
 * Only the kind and the path travel to Discord; names, titles and comment text stay on the
 * website, where visibility rules apply.
 */
export const noticeLocales = ['zh-Hant', 'zh-Hans', 'en', 'ja', 'ko'] as const;
export type NoticeLocale = (typeof noticeLocales)[number];
type Copy = Record<'comment_reply' | 'followed_work' | 'review_result' | 'registration_pack' | 'report_shipped' | 'generic', string>;
const copy: Record<NoticeLocale, Copy> = {
 'zh-Hant': {
  comment_reply: '有人回覆了你的留言。',
  followed_work: '你追蹤的作者發佈或更新了作品。',
  review_result: '你的作品審核結果出來了。',
  registration_pack: '你收到了額外的登記次數。',
  report_shipped: '你回報的問題已經在這次更新處理好了。',
  generic: 'HearthRoom 有新的通知。',
 },
 'zh-Hans': {
  comment_reply: '有人回复了你的留言。',
  followed_work: '你关注的作者发布或更新了作品。',
  review_result: '你的作品审核结果出来了。',
  registration_pack: '你收到了额外的登记次数。',
  report_shipped: '你反馈的问题已经在这次更新中处理好了。',
  generic: 'HearthRoom 有新的通知。',
 },
 en: {
  comment_reply: 'Someone replied to your comment.',
  followed_work: 'An author you follow published or updated a card.',
  review_result: 'The review of your card is complete.',
  registration_pack: 'You received extra registrations.',
  report_shipped: 'An update that addresses your report is now live.',
  generic: 'You have a new notification on HearthRoom.',
 },
 ja: {
  comment_reply: 'あなたのコメントに返信がありました。',
  followed_work: 'フォロー中の作者が作品を公開または更新しました。',
  review_result: 'あなたの作品の審査結果が出ました。',
  registration_pack: '追加の登録回数を受け取りました。',
  report_shipped: 'あなたが報告した問題は、今回の更新で対応されました。',
  generic: 'HearthRoom に新しいお知らせがあります。',
 },
 ko: {
  comment_reply: '내 댓글에 답글이 달렸습니다.',
  followed_work: '팔로우한 작가가 작품을 공개하거나 업데이트했습니다.',
  review_result: '내 작품의 검토 결과가 나왔습니다.',
  registration_pack: '추가 등록 횟수를 받았습니다.',
  report_shipped: '제보하신 문제가 이번 업데이트에서 해결되었습니다.',
  generic: 'HearthRoom에 새 알림이 있습니다.',
 },
};
const FALLBACK_PATH = '/me/community';
/** A website-relative path: one leading slash, no scheme, host, whitespace or control characters. */
export function safeNoticePath(path: unknown): string {
 return typeof path === 'string' && /^\/(?!\/)[\x21-\x7e]*$/.test(path) ? path : FALLBACK_PATH;
}
function line(kind: string, locale: NoticeLocale): string {
 const c = copy[locale];
 return kind in c && kind !== 'generic' ? c[kind as keyof Copy] : c.generic;
}
export function renderCommunityNotice(kind: string, path: unknown, site: string, locale?: unknown): string {
 const known = kind in copy['zh-Hant'] && kind !== 'generic';
 const destination = known ? safeNoticePath(path) : FALLBACK_PATH;
 const text = noticeLocales.includes(locale as NoticeLocale)
  ? line(kind, locale as NoticeLocale)
  : line(kind, 'zh-Hant') + ' / ' + line(kind, 'en');
 return text + '\n<' + site + destination + '>';
}

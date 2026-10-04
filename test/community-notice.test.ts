import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCommunityNotice } from '../src/community/notice.js';
import { CommunityBot } from '../src/community/bot.js';
const site = 'https://sukisuki.ai';
test('a notice names what happened in the member language and links straight to it', () => {
 const en = renderCommunityNotice('comment_reply', '/cards/12', site, 'en');
 assert.match(en, /replied/i);
 assert.ok(en.includes('<' + site + '/cards/12>'));
 assert.ok(!en.includes('社群通知'));
 const ko = renderCommunityNotice('followed_work', '/cards/7', site, 'ko');
 assert.match(ko, /작가|작품/);
 assert.ok(ko.includes(site + '/cards/7'));
 const hans = renderCommunityNotice('review_result', '/mine', site, 'zh-Hans');
 assert.match(hans, /审核/);
 assert.ok(hans.includes(site + '/mine'));
 const ja = renderCommunityNotice('registration_pack', '/mine', site, 'ja');
 assert.match(ja, /登録/);
});
test('without a member language the notice stays bilingual', () => {
 const text = renderCommunityNotice('comment_reply', '/cards/12', site);
 assert.match(text, /回覆/);
 assert.match(text, /replied/i);
 assert.ok(text.includes(site + '/cards/12'));
});
test('unknown kinds and unsafe paths fall back to the notification list', () => {
 const unknown = renderCommunityNotice('something_new', '/cards/12', site, 'ja');
 assert.match(unknown, /お知らせ/);
 assert.ok(unknown.includes(site + '/me/community'));
 for (const bad of ['', 'cards/12', '//evil.example', '/cards/1 2', 'https://evil.example/x', '/cards/\n12'])
  assert.ok(renderCommunityNotice('comment_reply', bad, site, 'en').includes('<' + site + '/me/community>'), bad);
});
test('DM delivery renders the member language from the bridge and marks delivery', async () => {
 let content = '';
 const client = { users: { fetch: async () => ({ createDM: async () => ({ send: async (p: any) => { content = p.content; return { id: 'message' }; } }) }) } } as any;
 const bot = new CommunityBot(client, 'guild', { site, key: 'a'.repeat(64), databasePath: ':memory:', channels: [], roles: [] }, []);
 const calls: Record<string, unknown>[] = [];
 bot.call = async <T,>(_op: string, value: Record<string, unknown> = {}) => { calls.push(value); return { kind: 'comment_reply', path: '/cards/12', discord_id: 'member', locale: 'en' } as T; };
 try {
  await bot.notification('n1');
  assert.match(content, /replied/i);
  assert.ok(content.includes('<' + site + '/cards/12>'));
  assert.ok(!content.includes('/me>'));
  assert.deepEqual(calls.at(-1), { id: 'n1', delivered: true });
 } finally { bot.store.close(); }
});

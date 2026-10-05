import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCommunityNotice } from '../src/community/notice.js';
import { CommunityBot } from '../src/community/bot.js';
const site = 'https://sukisuki.ai';
test('a notice shows the sentence the website wrote and links straight to it', () => {
 const ko = renderCommunityNotice('“雨夜書店”이(가) 심사를 통과했습니다', '/mine', site, 'ko');
 assert.equal(ko, '“雨夜書店”이(가) 심사를 통과했습니다\n<' + site + '/mine>');
 const hant = renderCommunityNotice('「天道非要我成仙」審核通過了', '/mine', site, 'zh-Hant');
 assert.ok(hant.startsWith('「天道非要我成仙」審核通過了\n'));
});
test('names written by members stay plain text on one line', () => {
 const text = renderCommunityNotice('**粗體** [連結](https://evil.example) 卡\n<@123>', '/cards/12', site, 'en');
 assert.equal(text.split('\n').length, 2);
 assert.ok(text.includes('\\*\\*粗體\\*\\*'));
 assert.ok(text.includes('\\[連結\\](https://evil.example)'));
 assert.ok(text.includes('\\<@123\\>'));
 assert.ok(renderCommunityNotice('長'.repeat(1000), '/mine', site, 'en').length < 500);
});
test('without a sentence the notice is generic, bilingual when the language is unknown', () => {
 assert.match(renderCommunityNotice(undefined, '/mine', site, 'ja'), /お知らせ/);
 const both = renderCommunityNotice('  ', '/mine', site);
 assert.match(both, /新的通知/);
 assert.match(both, /new notification/);
});
test('unsafe paths fall back to the notification list', () => {
 for (const bad of ['', 'cards/12', '//evil.example', '/cards/1 2', 'https://evil.example/x', '/cards/\n12', null])
  assert.ok(renderCommunityNotice('x', bad, site, 'en').includes('<' + site + '/me/community>'), String(bad));
});
test('DM delivery sends the sentence from the bridge and marks delivery', async () => {
 let content = '';
 const client = { users: { fetch: async () => ({ createDM: async () => ({ send: async (p: any) => { content = p.content; return { id: 'message' }; } }) }) } } as any;
 const bot = new CommunityBot(client, 'guild', { site, key: 'a'.repeat(64), databasePath: ':memory:', channels: [], roles: [] }, []);
 const calls: Record<string, unknown>[] = [];
 bot.call = async <T,>(_op: string, value: Record<string, unknown> = {}) => { calls.push(value); return { kind: 'review_result', path: '/mine', discord_id: 'member', locale: 'en', text: '“Reviewed” did not pass review this time' } as T; };
 try {
  await bot.notification('n1');
  assert.ok(content.startsWith('“Reviewed” did not pass review this time\n'));
  assert.ok(content.includes('<' + site + '/mine>'));
  assert.ok(!content.includes('/me>'));
  assert.deepEqual(calls.at(-1), { id: 'n1', delivered: true });
 } finally { bot.store.close(); }
});

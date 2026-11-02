import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CaseStore } from '../src/cases/store.js';
import { executeCaseAdmin, CaseAdminCounts, SUPPORT_ACTOR } from '../src/cases/admin.js';

function fixture(t: { after: (fn: () => void) => void }, category = 'bug') {
  const dir = mkdtempSync(join(tmpdir(), 'hk-admin-'));
  const options = { path: join(dir, 'cases.db'), guildId: 'guild', key: '11'.repeat(32), lookupKey: '22'.repeat(32), now: () => 1_000_000 };
  const store = new CaseStore(options);
  const counts = new CaseAdminCounts(join(dir, 'counts.db'), options.lookupKey);
  t.after(() => { store.close(); counts.close(); rmSync(dir, { recursive: true, force: true }); });
  const c = store.create({ guildId: 'guild', userId: 'reporter', staff: false }, { title: 'Fixture', body: 'Initial report', mode: 'identified', category, privateParentId: 'parent' }, 'create');
  store.privateThread(c.id, 'thread');
  const run = (command: Record<string, unknown>) => executeCaseAdmin(store, 'guild', command, counts);
  return { store, counts, options, c, run };
}

test('support actions use CaseStore transitions, persist events and hide reporter identity', t => {
  const { run, c, counts } = fixture(t);
  let version = c.version;
  for (const [action, state] of [['claim','in_progress'],['reply','in_progress'],['request_info','waiting_member'],['set_processing','in_progress'],['wait_technical','waiting_technical'],['pass','closed']]) {
    const result = run({ action, caseId: c.id, version, requestKey: `request-${version}`, body: action === 'claim' ? '' : 'Support response' });
    assert.equal(result.state, state);
    assert.equal(result.version, ++version);
    assert.equal(result.events.at(-1)?.kind, action);
    assert.equal(result.events.at(-1)?.body, action === 'claim' ? '' : 'Support response');
    assert.doesNotMatch(JSON.stringify(result), /reporter/);
  }
  assert.equal(counts.rows().filter(r => r.outcome === 'success').reduce((n, r) => n + r.total, 0), 6);
  assert.equal(SUPPORT_ACTOR, 'service:suki-support');
});

test('feedback supports discussion and not-adopted; forbidden workflow actions are rejected', t => {
  const { c, run } = fixture(t, 'review');
  const discussion = run({ action: 'discuss', caseId: c.id, version: c.version, requestKey: 'discussion', body: 'Reviewing suggestion' });
  assert.equal(discussion.state, 'under_discussion');
  const closed = run({ action: 'not_adopted', caseId: c.id, version: discussion.version, requestKey: 'not-adopted', body: 'Reason' });
  assert.equal(closed.resolution, 'not_adopted');
  const f = fixture(t);
  assert.throws(() => f.run({ action: 'not_adopted', caseId: f.c.id, version: 1, requestKey: 'bad-decision', body: 'Reason' }), /invalid/);
});

test('version conflicts refuse mutation; retries keep the same event across reopened stores', t => {
  const { run, c, store, options, counts } = fixture(t);
  const command = { action: 'reply', threadId: 'thread', version: c.version, requestKey: 'same-request', body: 'Reply' };
  const first = run(command);
  assert.equal(run(command).version, first.version);
  assert.equal(run(command).events.length, 2);
  assert.throws(() => run({ ...command, requestKey: 'different-request' }), /stale/);
  const reopened = new CaseStore(options);
  try { assert.equal(executeCaseAdmin(reopened, 'guild', command, counts).events.length, 2); }
  finally { reopened.close(); }
  const view = store.read({ guildId: 'guild', userId: SUPPORT_ACTOR, staff: true }, c.id);
  assert.equal(view.events.length, 2);
  assert.equal(counts.rows().find(r => r.outcome === 'conflict')?.total, 1);
});

test('show resolves a thread and rejects caller-controlled authority, unsafe actions and missing guards', t => {
  const { run, c, store } = fixture(t);
  assert.equal(run({ action: 'show', threadId: 'thread' }).id, c.id);
  for (const bad of [
    { action: 'archive' }, { action: 'reopen' }, { action: 'set_waiting' },
    { action: 'reply', userId: 'other' }, { action: 'reply', staff: true },
    { action: 'reply', version: undefined }, { action: 'reply', requestKey: '' },
    { action: 'reply', body: '' }, { action: 'reply', caseId: undefined, threadId: 'missing' },
  ]) assert.throws(() => run({ caseId: c.id, version: 1, requestKey: 'unsafe-request', body: 'Text', ...bad }));
  assert.equal(store.projection(c.id).version, 1);
});

test('admin aggregate counts survive restart without storing private content or identities', t => {
  const { counts, run, c } = fixture(t);
  run({ action: 'claim', caseId: c.id, version: 1, requestKey: 'claim-once' });
  const reopened = new CaseAdminCounts(counts.path);
  try { assert.deepEqual(reopened.rows(), [{ action: 'claim', outcome: 'success', total: 1 }]); }
  finally { reopened.close(); }
});

test('a reused request key rejects different content or authority targets', t => {
  const { run, c } = fixture(t);
  const command = { action: 'reply', caseId: c.id, version: 1, requestKey: 'bound-request', body: 'First reply' };
  run(command);
  assert.throws(() => run({ ...command, body: 'Changed reply' }), /request_conflict/);
  assert.throws(() => run({ ...command, action: 'pass' }), /request_conflict/);
  assert.equal(run({ action: 'show', caseId: c.id }).events.length, 2);
});

test('root drops supplementary groups before changing gid and uid, and failures stop the sequence', async () => {
  const { dropCaseAdminPrivileges } = await import('../src/case-admin.js');
  const order: string[] = [];
  const ops = { getuid: () => 0,
    setgroups: (groups: readonly (string | number)[]) => { assert.deepEqual(groups, []); order.push('groups'); },
    setgid: (id: string | number) => { assert.equal(id, 'hearthkeeper'); order.push('gid'); },
    setuid: (id: string | number) => { assert.equal(id, 'hearthkeeper'); order.push('uid'); } };
  dropCaseAdminPrivileges(ops);
  assert.deepEqual(order, ['groups','gid','uid']);
  order.length = 0;
  dropCaseAdminPrivileges({ ...ops, getuid: () => 1000 });
  assert.deepEqual(order, []);
  assert.throws(() => dropCaseAdminPrivileges({ ...ops, setgroups: () => { throw new Error('denied'); } }), /denied/);
  assert.deepEqual(order, []);
});

test('runCaseAdmin reads runtime-env configuration and exercises guarded SQLite actions across invocations', async t => {
  const { runCaseAdmin } = await import('../src/case-admin.js');
  const dir = mkdtempSync(join(tmpdir(), 'hk-admin-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = { path: join(dir, 'cases.db'), guildId: '100000000000000002', key: '11'.repeat(32), lookupKey: '22'.repeat(32) };
  const store = new CaseStore(options);
  const c = store.create({ guildId: options.guildId, userId: 'reporter', staff: false }, { title: 'Fixture', body: 'Question', category: 'bug', mode: 'identified' }, 'cli-create');
  store.close();
  const envText = Object.entries({ DISCORD_TOKEN: 'synthetic-token', DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_GUILD_ID: options.guildId,
    CASE_FORUM_ID: '100000000000000003', CASE_STAFF_ROLE_IDS: '100000000000000004', CASE_DATABASE_PATH: options.path,
    CASE_IDENTITY_KEY: options.key, CASE_LOOKUP_KEY: options.lookupKey }).map(([key, value]) => `${key}="${value}"`).join('\n');
  const command = JSON.stringify({ action: 'reply', caseId: c.id, version: 1, requestKey: 'cli-reply-once', body: 'Formal response' });
  assert.equal(runCaseAdmin(command, envText).version, 2);
  assert.equal(runCaseAdmin(command, envText).events.length, 2);
  assert.equal(runCaseAdmin(JSON.stringify({ action: 'show', caseId: c.id }), envText).version, 2);
  assert.throws(() => runCaseAdmin(command.replace('cli-reply-once', 'cli-stale-key'), envText), /stale/);
  assert.throws(() => runCaseAdmin('{', envText));
  assert.throws(() => runCaseAdmin(JSON.stringify({ action: 'reply', caseId: c.id, version: 2, requestKey: 'no-authority', body: 'Text', staff: true }), envText), /denied/);
});


test('case-admin CLI executes through release/current symlinks and rejects arguments before reading runtime.env', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hk-admin-current-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  mkdirSync(join(dir, 'releases'));
  symlinkSync(root, join(dir, 'releases', 'candidate'), 'dir');
  symlinkSync(join(dir, 'releases', 'candidate'), join(dir, 'current'), 'dir');
  // Invalid argv is rejected before any environment/privilege/database access,
  // so this remains safe when the suite runs as root on the real host.
  const run = (script: string) => spawnSync(process.execPath, ['--import', 'tsx', script, '--invalid-argument'], { cwd: root, encoding: 'utf8' });
  const direct = run(join(root, 'src', 'case-admin.ts'));
  const viaCurrent = run(join(dir, 'current', 'src', 'case-admin.ts'));
  assert.equal(direct.status, 1, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), { ok: false, error: 'invalid' });
  assert.equal(viaCurrent.status, direct.status, 'current must execute the same CLI entrypoint as its release');
  assert.deepEqual(JSON.parse(viaCurrent.stdout), JSON.parse(direct.stdout));
});

test('entry detection resolves both paths and returns false on invalid or missing paths', async t => {
  const { isEntry } = await import('../src/case-admin.js');
  const dir = mkdtempSync(join(tmpdir(), 'hk-entry-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../src/case-admin.ts', import.meta.url));
  const alias = join(dir, 'entry.ts');
  symlinkSync(entry, alias);
  const { pathToFileURL } = await import('node:url');
  assert.equal(isEntry(pathToFileURL(alias).href, entry), true);
  assert.equal(isEntry(pathToFileURL(entry).href, alias), true);
  assert.equal(isEntry(import.meta.url, entry), false);
  assert.equal(isEntry(pathToFileURL(entry).href, undefined), false);
  assert.equal(isEntry('https://invalid.test/module.js', entry), false);
  assert.equal(isEntry(pathToFileURL(entry).href, join(dir, 'missing')), false);
});

test('importing case-admin with a nonexistent argv path never launches CLI or throws', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const moduleUrl = new URL('../src/case-admin.ts', import.meta.url).href;
  const code = `process.argv[1] = '/nonexistent/hearthkeeper-entry-probe'; await import(${JSON.stringify(moduleUrl)}); console.log('imported');`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'imported');
});

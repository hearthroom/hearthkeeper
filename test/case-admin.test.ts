import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CaseError, type CaseStore, type CaseView, type Action } from './store.js';

export const SUPPORT_ACTOR = 'service:suki-support';
export const supportActions = ['claim', 'reply', 'request_info', 'set_processing', 'wait_technical', 'discuss', 'pass', 'not_adopted'] as const;
const metricActions = [...supportActions, 'show', 'other'];
const outcomes = ['success', 'conflict', 'denied', 'failed'];
export type AdminCount = { action: string; outcome: string; total: number };

/** Aggregate command attempts only: no request keys, case IDs, actors or content. */
export class CaseAdminCounts {
  private db: DatabaseSync;
  constructor(readonly path: string, private fingerprintKey?: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS command_totals(action TEXT NOT NULL,outcome TEXT NOT NULL,total INTEGER NOT NULL,PRIMARY KEY(action,outcome)); CREATE TABLE IF NOT EXISTS command_keys(key_hash TEXT PRIMARY KEY,payload_hash TEXT NOT NULL)');
  }
  bind(requestKey: string, payload: string) {
    if (!this.fingerprintKey) throw new CaseError('disabled');
    const hash = (s: string) => createHmac('sha256', this.fingerprintKey!).update(s).digest('hex');
    const key = hash(requestKey), value = hash(payload);
    this.db.prepare('INSERT OR IGNORE INTO command_keys VALUES(?,?)').run(key, value);
    const old = this.db.prepare('SELECT payload_hash FROM command_keys WHERE key_hash=?').get(key);
    if (old?.payload_hash !== value) throw new CaseError('request_conflict');
  }
  record(action: string, outcome: string) {
    this.db.prepare('INSERT INTO command_totals VALUES(?,?,1) ON CONFLICT(action,outcome) DO UPDATE SET total=total+1')
      .run(metricActions.includes(action) ? action : 'other', outcomes.includes(outcome) ? outcome : 'failed');
  }
  rows(): AdminCount[] {
    return this.db.prepare('SELECT action,outcome,total FROM command_totals ORDER BY action,outcome').all().map(r => ({ ...r })) as AdminCount[];
  }
  close() { this.db.close(); }
}

function safeView(c: CaseView) {
  return {
    id: c.id, title: c.title, category: c.category, version: c.version,
    state: c.state, resolution: c.resolution, archived: c.archived, locked: c.locked,
    sync: c.sync, privatePending: c.privatePending ?? false, privateThreadId: c.privateThreadId ?? null,
    events: c.events.map(({ seq, kind, body }) => ({ seq, kind, body })),
    actor: SUPPORT_ACTOR,
  };
}

/** This private SSH entry point has one service actor; caller-supplied authority is rejected. */
export function executeCaseAdmin(store: CaseStore, guildId: string, raw: unknown, counts: CaseAdminCounts) {
  let action = 'other';
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CaseError('invalid');
    const cmd = raw as Record<string, unknown>;
    action = typeof cmd.action === 'string' ? cmd.action : 'other';
    if (![...supportActions, 'show'].includes(action as typeof supportActions[number]) ||
        Object.keys(cmd).some(k => !['action', 'caseId', 'threadId', 'version', 'requestKey', 'body'].includes(k)))
      throw new CaseError('denied');
    if ((typeof cmd.caseId === 'string') === (typeof cmd.threadId === 'string')) throw new CaseError('invalid');
    const id = typeof cmd.caseId === 'string' ? cmd.caseId : store.privateCaseForThread(String(cmd.threadId));
    if (!id || id.length > 100) throw new CaseError('missing');
    const actor = { guildId, userId: SUPPORT_ACTOR, staff: true };
    let result: CaseView;
    if (action === 'show') {
      if (Object.keys(cmd).some(k => !['action', 'caseId', 'threadId'].includes(k))) throw new CaseError('invalid');
      result = store.read(actor, id);
    } else {
      if (!Number.isSafeInteger(cmd.version) || Number(cmd.version) < 1 ||
          typeof cmd.requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(cmd.requestKey) ||
          (action !== 'claim' && (typeof cmd.body !== 'string' || !cmd.body.trim() || cmd.body.length > 1400)) ||
          (action === 'claim' && cmd.body !== undefined && cmd.body !== '')) throw new CaseError('invalid');
      counts.bind(cmd.requestKey, JSON.stringify([id, cmd.version, action, cmd.body ?? '']));
      result = store.act(actor, id, Number(cmd.version), action as Action, String(cmd.body ?? ''), 'support:' + cmd.requestKey);
    }
    counts.record(action, 'success');
    return safeView(result);
  } catch (error) {
    const code = error instanceof CaseError ? error.message : 'failed';
    counts.record(action, ['stale', 'request_conflict'].includes(code) ? 'conflict' : error instanceof CaseError ? 'denied' : 'failed');
    throw new CaseError(code);
  }
}

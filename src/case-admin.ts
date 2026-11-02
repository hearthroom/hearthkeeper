import { readFileSync, realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { CaseStore, CaseError } from './cases/store.js';
import { CaseAdminCounts, executeCaseAdmin } from './cases/admin.js';

export function runCaseAdmin(input: string, envText: string) {
  if (input.length > 20_000) throw new CaseError('invalid');
  const command: unknown = JSON.parse(input);
  // Fixed runtime.env on the host. No caller-controlled database, keys or service actor.
  const config = loadConfig(parseEnv(envText));
  if (!config.cases) throw new CaseError('disabled');
  const store = new CaseStore({ path: config.cases.databasePath, guildId: config.guildId, key: config.cases.key, lookupKey: config.cases.lookupKey });
  let counts: CaseAdminCounts | undefined;
  try {
    counts = new CaseAdminCounts(config.cases.databasePath + '.admin-metrics', config.cases.lookupKey);
    return executeCaseAdmin(store, config.guildId, command, counts);
  } finally { counts?.close(); store.close(); }
}

export function dropCaseAdminPrivileges(ops: Pick<NodeJS.Process, 'getuid' | 'setgroups' | 'setgid' | 'setuid'> = process) {
  if (ops.getuid?.() === 0) {
    ops.setgroups!([]);
    ops.setgid!('hearthkeeper');
    ops.setuid!('hearthkeeper');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new CaseError('invalid');
    const input = readFileSync(0, 'utf8');
    const envText = readFileSync('/etc/hearthkeeper/runtime.env', 'utf8');
    dropCaseAdminPrivileges();
    const result = runCaseAdmin(input, envText);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) {
    const code = error instanceof CaseError ? error.message : 'failed';
    // Never print raw parsing, configuration, SDK or SQLite errors.
    process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
    process.exitCode = 1;
  }
}

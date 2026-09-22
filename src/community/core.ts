import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
export interface XPEvent {
  id: string;
  user: string;
  channel: string;
  time: number;
}
export class CommunityStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,payload TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS roles(user TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(user,role));
 CREATE TABLE IF NOT EXISTS review_attempts(id TEXT NOT NULL,channel TEXT NOT NULL,started_at INTEGER NOT NULL,PRIMARY KEY(id,channel));
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,external_id TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  enqueue(event: XPEvent) {
    this.db
      .prepare("INSERT OR IGNORE INTO events VALUES(?,?,0,?)")
      .run(event.id, JSON.stringify(event), event.time);
  }
  pending() {
    return (
      this.db
        .prepare(
          "SELECT payload FROM events WHERE done=0 ORDER BY created_at LIMIT 50",
        )
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as XPEvent);
  }
  ack(id: string) {
    this.db.prepare("UPDATE events SET done=1 WHERE id=?").run(id);
  }
  prune() {
    this.db
      .prepare("DELETE FROM deliveries WHERE created_at<?")
      .run(Date.now() - 2592000000);
    this.db
      .prepare("DELETE FROM events WHERE created_at<?")
      .run(Date.now() - 172800000);
  }
  owned(user: string) {
    return (
      this.db.prepare("SELECT role FROM roles WHERE user=?").all(user) as {
        role: string;
      }[]
    ).map((r) => r.role);
  }
  own(user: string, role: string) {
    this.db.prepare("INSERT OR IGNORE INTO roles VALUES(?,?)").run(user, role);
  }
  forget(user: string, role: string) {
    this.db
      .prepare("DELETE FROM roles WHERE user=? AND role=?")
      .run(user, role);
  }
  delivered(id: string) {
    return (
      this.db
        .prepare("SELECT external_id FROM deliveries WHERE id=?")
        .get(id) as { external_id: string } | undefined
    )?.external_id;
  }
  receipt(id: string, external: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO deliveries VALUES(?,?,?)")
      .run(id, external, Date.now());
  }
  beginReviewAttempt(id:string,channel:string,now:number){this.db.prepare('INSERT OR IGNORE INTO review_attempts VALUES(?,?,?)').run(id,channel,now);}
  reviewAttempt(id:string,channel:string){return (this.db.prepare('SELECT started_at FROM review_attempts WHERE id=? AND channel=?').get(id,channel) as {started_at:number}|undefined)?.started_at;}
  finishReviewAttempt(id:string,channel:string){this.db.prepare('DELETE FROM review_attempts WHERE id=? AND channel=?').run(id,channel);}
  close() {
    this.db.close();
  }
}
export function signedHeaders(
  key: string,
  path: string,
  body: string,
  time = Date.now(),
  nonce = randomUUID() as string,
) {
  const stamp = String(time);
  const signature = createHmac("sha256", key)
    .update(
      [
        "POST",
        path,
        stamp,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Community-Time": stamp,
    "X-Community-Nonce": nonce,
    "X-Community-Signature": signature,
  };
}
interface MessageMetadata {
  guildId: string | null;
  channelId: string;
  author: { bot: boolean };
  webhookId: string | null;
  system: boolean;
  type: number;
  channel: { isThread(): boolean; public: boolean };
}
export function eligibleMessage(
  m: MessageMetadata,
  guild: string,
  channels: string[],
) {
  return (
    m.guildId === guild &&
    channels.includes(m.channelId) &&
    !m.author.bot &&
    !m.webhookId &&
    !m.system &&
    m.type === 0 &&
    !m.channel.isThread() &&
    m.channel.public
  );
}
export interface RoleSafety {
  id: string;
  position: number;
  managed: boolean;
  permissions: bigint;
  overwriteAllow: bigint;
}
export function rolePlan(
  roles: RoleSafety[],
  desired: string[],
  current: string[],
  owned: string[],
  botPosition: number,
  staff: string[],
) {
  const allowed = new Set(roles.map((r) => r.id));
  if (owned.some((id) => !allowed.has(id) && current.includes(id)))
    throw new Error("role_denied");
  for (const id of desired) {
    const r = roles.find((r) => r.id === id);
    if (
      !r ||
      r.managed ||
      r.position >= botPosition ||
      r.permissions !== 0n ||
      r.overwriteAllow !== 0n ||
      staff.includes(id)
    )
      throw new Error("role_denied");
  }
  return {
    add: desired.filter((id) => !current.includes(id)),
    remove: owned.filter(
      (id) => allowed.has(id) && !desired.includes(id) && current.includes(id),
    ),
  };
}

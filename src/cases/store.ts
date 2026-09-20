import {
  categories,
  forumActions,
  statusActions,
  internalActions,
} from "./catalog.js";
import { DatabaseSync } from "node:sqlite";
import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
export interface Actor {
  guildId: string;
  userId: string;
  staff: boolean;
}
export type Action =
  | "claim"
  | "reply"
  | "request_info"
  | "close"
  | "reopen"
  | "supplement"
  | "request_close"
  | "request_reopen"
  | "reject"
  | "archive"
  | "lock"
  | "archive_lock"
  | "restore"
  | "set_waiting"
  | "set_processing"
  | "wait_technical";
export type State =
  | "submitted"
  | "in_progress"
  | "waiting_member"
  | "waiting_technical"
  | "closed";
export interface CaseEvent {
  seq: number;
  kind: string;
  body: string;
  deliveryKey: string;
  status: string;
  externalId: string | null;
}
export interface CaseView {
  id: string;
  createdAt: number;
  title: string;
  mode: "anonymous" | "identified";
  category: string;
  archived: boolean;
  locked: boolean;
  state: State;
  version: number;
  threadId: string | null;
  sync: "pending" | "synced";
  events: CaseEvent[];
  reporter?: string;
  request: string | null;
}
interface Row {
  id: string;
  created_at: number;
  title: string;
  mode: "anonymous" | "identified";
  category: string;
  archived: number;
  locked: number;
  state: State;
  version: number;
  thread_id: string | null;
  projected_version: number;
  closed_at: number | null;
  request: string | null;
}
export class CaseError extends Error {}
const token = () => randomBytes(12).toString("hex");
export class CaseStore {
  private db: DatabaseSync;
  private stopped = false;
  readonly now: () => number;
  private key: Buffer;
  private lookupKey: Buffer;
  constructor(
    private options: {
      path: string;
      guildId: string;
      key: string;
      lookupKey: string;
      now?: () => number;
    },
  ) {
    if (
      !/^[a-f0-9]{64}$/i.test(options.key) ||
      !/^[a-f0-9]{64}$/i.test(options.lookupKey) ||
      options.key === options.lookupKey
    )
      throw new Error("Invalid case keys");
    this.key = Buffer.from(options.key, "hex");
    this.lookupKey = Buffer.from(options.lookupKey, "hex");
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY,guild TEXT NOT NULL,title TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL,closed_at INTEGER,thread_id TEXT,projected_version INTEGER NOT NULL DEFAULT 0,request TEXT);
  CREATE TABLE IF NOT EXISTS identities(case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,owner_key TEXT NOT NULL,sealed TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,seq INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,delivery_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'queued',external_id TEXT,PRIMARY KEY(case_id,seq));
  CREATE TABLE IF NOT EXISTS operations(request_key TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,actor_key TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS actions(token TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,actor_key TEXT,action TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL,staff INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS deletions(thread_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS member_writes(owner_key TEXT PRIMARY KEY,written_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS identities_owner ON identities(owner_key);
  `);
    const fingerprint = createHmac("sha256", this.key)
      .update(options.guildId)
      .update(this.lookupKey)
      .digest("hex");
    const old = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get("key_check") as { value: string } | undefined;
    if (old && old.value !== fingerprint) {
      this.db.close();
      throw new Error("Case key or guild mismatch");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES(?,?)")
      .run("key_check", fingerprint);
    // Additive migration: preserve existing cases and their closed projection flags.
    const columns = this.db.prepare("PRAGMA table_info(cases)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "category"))
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE cases ADD COLUMN category TEXT NOT NULL DEFAULT 'general'; ALTER TABLE cases ADD COLUMN archived INTEGER NOT NULL DEFAULT 0; ALTER TABLE cases ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;",
        );
        this.db.exec(
          "UPDATE cases SET archived=1,locked=1 WHERE state='closed'",
        );
      });
    // Replay the independent deletion ledger before accepting interactions after restore.
    const ledger = options.path + ".deletions.jsonl";
    if (existsSync(ledger)) {
      for (const line of readFileSync(ledger, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const entry = JSON.parse(line) as { threadId: string };
        if (typeof entry.threadId !== "string")
          throw new Error("Invalid deletion ledger");
        this.db
          .prepare("DELETE FROM cases WHERE thread_id=?")
          .run(entry.threadId);
        this.db
          .prepare("INSERT OR IGNORE INTO deletions VALUES(?)")
          .run(entry.threadId);
      }
    }
  }
  close() {
    if (!this.stopped) {
      this.db.close();
      this.stopped = true;
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private actor(a: Actor) {
    if (a.guildId !== this.options.guildId || !a.userId)
      throw new CaseError("denied");
    return createHmac("sha256", this.lookupKey)
      .update(a.guildId + ":" + a.userId)
      .digest("hex");
  }
  private seal(id: string) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(this.options.guildId));
    return Buffer.concat([
      iv,
      Buffer.from(c.update(id, "utf8")),
      c.final(),
      c.getAuthTag(),
    ]).toString("base64");
  }
  private unseal(value: string) {
    const b = Buffer.from(value, "base64"),
      d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(this.options.guildId));
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
  }
  private row(id: string) {
    const row = this.db
      .prepare("SELECT * FROM cases WHERE id=? AND guild=?")
      .get(id, this.options.guildId) as unknown as Row | undefined;
    if (!row) throw new CaseError("denied");
    return row;
  }
  private authorize(a: Actor, id: string) {
    const k = this.actor(a),
      row = this.row(id);
    if (
      !a.staff &&
      !this.db
        .prepare("SELECT 1 FROM identities WHERE case_id=? AND owner_key=?")
        .get(id, k)
    )
      throw new CaseError("denied");
    return row;
  }
  private text(text: string, max: number) {
    const s = text.trim();
    if (!s || s.length > max) throw new CaseError("invalid");
    return s;
  }
  private replay(a: Actor, requestKey: string) {
    const r = this.db
      .prepare("SELECT case_id,actor_key FROM operations WHERE request_key=?")
      .get(requestKey) as { case_id: string; actor_key: string } | undefined;
    if (r && r.actor_key !== this.actor(a)) throw new CaseError("denied");
    return r?.case_id;
  }
  private record(
    a: Actor,
    id: string,
    kind: string,
    body: string,
    seq: number,
    requestKey: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO events(case_id,seq,kind,body,delivery_key) VALUES(?,?,?,?,?)",
      )
      .run(id, seq, kind, body, token());
    this.db
      .prepare("INSERT INTO operations VALUES(?,?,?)")
      .run(requestKey, id, this.actor(a));
    this.db
      .prepare("INSERT INTO audit VALUES(?,?,?,?)")
      .run(id, this.now(), this.seal(a.userId), kind);
  }
  create(
    a: Actor,
    input: {
      title: string;
      body: string;
      mode: "anonymous" | "identified";
      category?: string;
    },
    requestKey: string,
  ) {
    return this.transaction(() => {
      const owner = this.actor(a),
        repeat = this.replay(a, requestKey);
      if (repeat) return this.read(a, repeat);
      const title = this.text(input.title, 80),
        body = this.text(input.body, 1400);
      if (!["anonymous", "identified"].includes(input.mode))
        throw new CaseError("invalid");
      const counts = this.db
        .prepare(
          `SELECT count(*) AS total,max(created_at) AS latest,sum(CASE WHEN state!='closed' THEN 1 ELSE 0 END) AS opened FROM cases c JOIN identities i ON c.id=i.case_id WHERE i.owner_key=? AND c.guild=?`,
        )
        .get(owner, a.guildId) as {
        total: number;
        latest: number | null;
        opened: number | null;
      };
      if (counts.latest !== null && this.now() - counts.latest < 60000)
        throw new CaseError("cooldown");
      if ((counts.opened ?? 0) >= 3) throw new CaseError("limit");
      const category = input.category ?? "general";
      if (category !== "general" && !categories.some((c) => c.id === category))
        throw new CaseError("invalid");
      const id = token();
      this.db
        .prepare(
          "INSERT INTO cases(id,guild,title,mode,state,version,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, a.guildId, title, input.mode, "submitted", 1, this.now());
      this.db
        .prepare("UPDATE cases SET category=? WHERE id=?")
        .run(category, id);
      this.db
        .prepare("INSERT INTO identities VALUES(?,?,?)")
        .run(id, owner, this.seal(a.userId));
      this.record(a, id, "submitted", body, 1, requestKey);
      return this.read(a, id);
    });
  }
  list(a: Actor, offset = 0): CaseView[] {
    const key = this.actor(a);
    const rows = (
      a.staff
        ? this.db
            .prepare(
              "SELECT id FROM cases WHERE guild=? ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET ?",
            )
            .all(a.guildId, offset)
        : this.db
            .prepare(
              "SELECT c.id FROM cases c JOIN identities i ON c.id=i.case_id WHERE c.guild=? AND i.owner_key=? ORDER BY created_at DESC,c.id DESC LIMIT 10 OFFSET ?",
            )
            .all(a.guildId, key, offset)
    ) as { id: string }[];
    return rows.map((r) => this.read(a, r.id));
  }
  read(a: Actor, id: string): CaseView {
    this.authorize(a, id);
    return this.view(id, a.staff);
  }
  private view(id: string, includeIdentity = false): CaseView {
    const r = this.row(id);
    const events = this.db
      .prepare(
        "SELECT seq,kind,body,delivery_key AS deliveryKey,status,external_id AS externalId FROM events WHERE case_id=? ORDER BY seq",
      )
      .all(id) as unknown as CaseEvent[];
    const c: CaseView = {
      id: r.id,
      createdAt: r.created_at,
      title: r.title,
      mode: r.mode,
      category: r.category,
      archived: !!r.archived,
      locked: !!r.locked,
      state: r.state,
      version: r.version,
      threadId: r.thread_id,
      sync:
        r.projected_version === r.version &&
        events.every((e) => e.status === "done")
          ? "synced"
          : "pending",
      events: includeIdentity
        ? events
        : events.filter((e) => !internalActions.includes(e.kind)),
      request: r.request,
    };
    if (includeIdentity && r.mode === "identified") {
      const v = this.db
        .prepare("SELECT sealed FROM identities WHERE case_id=?")
        .get(id) as { sealed: string };
      c.reporter = this.unseal(v.sealed);
    }
    return c;
  }
  projection(id: string) {
    return this.view(id, true);
  }
  caseForThread(threadId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT id FROM cases WHERE thread_id=? AND guild=?")
        .get(threadId, this.options.guildId) as { id: string } | undefined
    )?.id;
  }
  act(
    a: Actor,
    id: string,
    version: number,
    kind: Action,
    body: string,
    requestKey: string,
  ) {
    return this.transaction(() => {
      const r = this.authorize(a, id),
        repeat = this.replay(a, requestKey);
      if (repeat) {
        if (repeat !== id) throw new CaseError("denied");
        return this.read(a, id);
      }
      if (r.version !== version) throw new CaseError("stale");
      const memberAction = [
        "supplement",
        "request_close",
        "request_reopen",
      ].includes(kind);
      if (!memberAction && !a.staff) throw new CaseError("denied");
      if (memberAction) {
        const last = this.db
          .prepare("SELECT written_at FROM member_writes WHERE owner_key=?")
          .get(this.actor(a)) as { written_at: number } | undefined;
        if (last && this.now() - last.written_at < 5000)
          throw new CaseError("reply_cooldown");
        this.db
          .prepare(
            "INSERT INTO member_writes VALUES(?,?) ON CONFLICT(owner_key) DO UPDATE SET written_at=excluded.written_at",
          )
          .run(this.actor(a), this.now());
        const owner = this.db
          .prepare("SELECT owner_key FROM identities WHERE case_id=?")
          .get(id) as { owner_key: string };
        if (owner.owner_key !== this.actor(a)) throw new CaseError("denied");
      }
      if (kind !== "claim") body = this.text(body, 1400);
      else body = "";
      let archived = !!r.archived,
        locked = !!r.locked;
      let state = r.state,
        request = r.request;
      if (forumActions.includes(kind)) {
        if (r.state === "closed") throw new CaseError("closed");
        if (kind === "archive") archived = true;
        if (kind === "lock") locked = true;
        if (kind === "archive_lock") {
          archived = true;
          locked = true;
        }
        if (kind === "restore") {
          archived = false;
          locked = false;
        }
      } else if (statusActions.includes(kind)) {
        if (state === "closed") throw new CaseError("closed");
        state =
          kind === "set_waiting"
            ? "submitted"
            : kind === "wait_technical"
              ? "waiting_technical"
              : "in_progress";
      } else if (kind === "supplement") {
        if (state === "closed") throw new CaseError("closed");
        // Member updates do not imply a moderator has started work.
        if (state === "waiting_member") state = "submitted";
      } else if (kind === "request_close" || kind === "request_reopen") {
        if (request) throw new CaseError("pending");
        if ((kind === "request_reopen") !== (state === "closed"))
          throw new CaseError("stale");
        request = kind;
      } else if (kind === "close") {
        if (state === "closed") throw new CaseError("closed");
        state = "closed";
        archived = true;
        locked = true;
        request = null;
      } else if (kind === "reopen") {
        if (state !== "closed") throw new CaseError("stale");
        state = "in_progress";
        archived = false;
        locked = false;
        request = null;
      } else if (kind === "reject") {
        if (!request) throw new CaseError("stale");
        request = null;
      } else {
        if (state === "closed") throw new CaseError("closed");
        if (kind === "claim") {
          if (state !== "submitted") throw new CaseError("stale");
          state = "in_progress";
        } else if (kind === "request_info") state = "waiting_member";
        else if (kind === "reply") state = "in_progress";
        else throw new CaseError("invalid");
      }
      this.db
        .prepare(
          "UPDATE cases SET state=?,request=?,version=version+1,closed_at=? WHERE id=?",
        )
        .run(
          state,
          request,
          state === "closed" ? (r.closed_at ?? this.now()) : null,
          id,
        );
      this.db
        .prepare("UPDATE cases SET archived=?,locked=? WHERE id=?")
        .run(archived ? 1 : 0, locked ? 1 : 0, id);
      this.record(a, id, kind, body, r.version + 1, requestKey);
      return this.read(a, id);
    });
  }
  action(
    a: Actor,
    id: string,
    action: string,
    version: number,
    sharedStaff = false,
  ) {
    this.authorize(a, id);
    if (sharedStaff && !a.staff) throw new CaseError("denied");
    const code = token();
    this.db
      .prepare("INSERT INTO actions VALUES(?,?,?,?,?,?,?)")
      .run(
        code,
        id,
        sharedStaff ? null : this.actor(a),
        action,
        version,
        this.now() + (sharedStaff ? 90 * 86400000 : 15 * 60000),
        sharedStaff ? 1 : 0,
      );
    return code;
  }
  // Identity proof for bot-owned starter messages, not an authorization check.
  // Expired controls remain useful for recovering an interrupted create.
  hasStaffAction(caseId: string, customId: string) {
    if (!customId.startsWith("hk:act:")) return false;
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM actions WHERE token=? AND case_id=? AND staff=1 AND actor_key IS NULL AND action IN ('staff_view','staff_forum')",
        )
        .get(customId.slice(7), caseId),
    );
  }
  resolve(a: Actor, code: string) {
    const actor = this.actor(a),
      r = this.db.prepare("SELECT * FROM actions WHERE token=?").get(code) as
        | {
            case_id: string;
            actor_key: string | null;
            action: string;
            version: number;
            expires: number;
            staff: number;
          }
        | undefined;
    if (!r || (r.staff && !a.staff) || (r.actor_key && r.actor_key !== actor))
      throw new CaseError("denied");
    if (r.expires < this.now()) throw new CaseError("expired");
    this.authorize(a, r.case_id);
    return { caseId: r.case_id, action: r.action, version: r.version };
  }
  pending() {
    return (
      this.db
        .prepare(
          "SELECT id FROM cases WHERE guild=? AND (projected_version<version OR EXISTS(SELECT 1 FROM events WHERE case_id=cases.id AND status!=?)) ORDER BY created_at LIMIT 20",
        )
        .all(this.options.guildId, "done") as { id: string }[]
    ).map((r) => this.projection(r.id));
  }
  markSending(id: string, seq: number) {
    this.db
      .prepare("UPDATE events SET status=? WHERE case_id=? AND seq=?")
      .run("sending", id, seq);
  }
  delivered(id: string, seq: number, externalId: string) {
    this.db
      .prepare(
        "UPDATE events SET status=?,external_id=? WHERE case_id=? AND seq=?",
      )
      .run("done", externalId, id, seq);
  }
  thread(id: string, threadId: string) {
    this.db
      .prepare("UPDATE cases SET thread_id=? WHERE id=?")
      .run(threadId, id);
  }
  synced(id: string, version: number) {
    this.db
      .prepare("UPDATE cases SET projected_version=? WHERE id=?")
      .run(version, id);
  }
  cleanup() {
    this.db
      .prepare("DELETE FROM member_writes WHERE written_at<?")
      .run(this.now() - 60000);
    this.db.prepare("DELETE FROM actions WHERE expires<?").run(this.now());
    const rows = this.db
      .prepare(
        "SELECT id,thread_id FROM cases WHERE closed_at IS NOT NULL AND closed_at<?",
      )
      .all(this.now() - 90 * 86400000) as {
      id: string;
      thread_id: string | null;
    }[];
    for (const r of rows) {
      if (r.thread_id)
        appendFileSync(
          this.options.path + ".deletions.jsonl",
          JSON.stringify({ threadId: r.thread_id }) + "\n",
          { mode: 0o600, flush: true },
        );
      this.transaction(() => {
        if (r.thread_id)
          this.db
            .prepare("INSERT OR IGNORE INTO deletions VALUES(?)")
            .run(r.thread_id);
        this.db.prepare("DELETE FROM cases WHERE id=?").run(r.id);
      });
    }
  }
  deletions() {
    return (
      this.db.prepare("SELECT thread_id FROM deletions").all() as {
        thread_id: string;
      }[]
    ).map((r) => r.thread_id);
  }
  deleted(id: string) {
    this.db.prepare("DELETE FROM deletions WHERE thread_id=?").run(id);
  }
}

import type {
  CaseStore,
  CaseView,
  CaseEvent,
  PrivateProjection,
} from "./store.js";
export interface PrivateTransport {
  verify(parent: string): Promise<void>;
  canCreate(parent: string): Promise<boolean>;
  findThread(p: PrivateProjection): Promise<string | null>;
  createThread(p: PrivateProjection): Promise<string>;
  findMessage(p: PrivateProjection, key: string): Promise<string | null>;
  sendEvent(p: PrivateProjection, c: CaseView, e: CaseEvent): Promise<string>;
  sync(p: PrivateProjection, c: CaseView): Promise<void>;
  settle?(p: PrivateProjection, c: CaseView): Promise<void>;
  remove(parent: string, thread: string): Promise<void>;
}
export class PrivateDeliveryWorker {
  private running = false;
  private cursor = "";
  constructor(
    private store: CaseStore,
    private transport: PrivateTransport,
    private observe: (
      outcome: "success" | "failure" | "capacity",
    ) => void = () => {},
  ) {}
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (const d of this.store.privateDeletions()) {
        try {
          await this.transport.remove(d.parentId, d.threadId);
          this.store.privateDeleted(d.threadId);
          this.observe("success");
        } catch {
          this.observe("failure");
        }
      }
      const batch = this.store.privatePending(this.cursor);
      if (!batch.length) this.cursor = "";
      for (let p of batch) {
        this.cursor = p.caseId;
        try {
          await this.transport.verify(p.parentId);
          if (!p.threadId) {
            let thread =
              p.status === "sending"
                ? await this.transport.findThread(p)
                : null;
            if (!thread) {
              if (p.status === "sending")
                throw new Error("private_create_unknown");
              if (!(await this.transport.canCreate(p.parentId))) {
                this.observe("capacity");
                continue;
              }
              this.store.privateCreating(p.caseId);
              thread = await this.transport.createThread(p);
            }
            this.store.privateThread(p.caseId, thread);
            p = this.store.privateProjection(p.caseId)!;
          }
          for (const e of p.events.filter((e) => e.status !== "done")) {
            await this.transport.verify(p.parentId);
            let message =
              e.status === "sending"
                ? await this.transport.findMessage(p, e.deliveryKey)
                : null;
            if (!message) {
              if (e.status === "sending")
                throw new Error("private_send_unknown");
              this.store.privateSending(p.caseId, e.seq);
              message = await this.transport.sendEvent(
                p,
                this.store.projection(p.caseId),
                e,
              );
            }
            this.store.privateDelivered(p.caseId, e.seq, message);
          }
          const c = this.store.projection(p.caseId);
          // Events may have arrived during Discord I/O. Never acknowledge a version not delivered.
          p = this.store.privateProjection(p.caseId)!;
          if (p.events.some((e) => e.status !== "done")) continue;
          await this.transport.verify(p.parentId);
          await this.transport.sync(p, c);
          this.store.privateSynced(c.id, c.version);
          this.observe("success");
        } catch {
          this.observe("failure");
        } finally {
          const current = this.store.privateProjection(p.caseId);
          if (current?.threadId && this.transport.settle) {
            try {
              await this.transport.settle(
                current,
                this.store.projection(p.caseId),
              );
            } catch {
              this.store.privateDirty(p.caseId);
              this.observe("failure");
            }
          }
        }
      }
      if (batch.length < 20) this.cursor = "";
    } finally {
      this.running = false;
    }
  }
}

import type { CaseStore, CaseView, CaseEvent } from "./store.js";
export interface Transport {
  verify(): Promise<void>;
  findThread(id: string): Promise<string | null>;
  createThread(c: CaseView, event: CaseEvent): Promise<string>;
  findMessage(thread: string, key: string): Promise<string | null>;
  sendEvent(thread: string, c: CaseView, event: CaseEvent): Promise<string>;
  sync(c: CaseView): Promise<void>;
  remove(thread: string): Promise<void>;
}
export class DeliveryWorker {
  private running = false;
  constructor(
    private store: CaseStore,
    private transport: Transport,
    private observe: (status: "success" | "failure") => void = () => {},
  ) {}
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      this.store.cleanup();
      for (const thread of this.store.deletions()) {
        try {
          await this.transport.verify();
          await this.transport.remove(thread);
          this.store.deleted(thread);
        } catch {
          this.observe("failure");
        }
      }
      for (const initial of this.store.pending()) {
        try {
          for (const event of initial.events.filter(
            (e) => e.status !== "done",
          )) {
            await this.transport.verify();
            let c = this.store.projection(initial.id);
            if (event.seq === 1) {
              let thread = c.threadId;
              if (!thread && event.status === "sending")
                thread = await this.transport.findThread(c.id);
              if (!thread) {
                if (event.status === "sending") throw new Error("unknown");
                this.store.markSending(c.id, event.seq);
                thread = await this.transport.createThread(c, event);
              }
              this.store.thread(c.id, thread);
              this.store.delivered(c.id, event.seq, thread);
            } else {
              if (!c.threadId) throw new Error("missing_thread");
              let message: string | null = null;
              if (event.status === "sending")
                message = await this.transport.findMessage(
                  c.threadId,
                  event.deliveryKey,
                );
              if (!message) {
                if (event.status === "sending") throw new Error("unknown");
                this.store.markSending(c.id, event.seq);
                message = await this.transport.sendEvent(c.threadId, c, event);
              }
              this.store.delivered(c.id, event.seq, message);
            }
          }
          await this.transport.verify();
          const current = this.store.projection(initial.id);
          await this.transport.sync(current);
          this.store.synced(current.id, current.version);
          this.observe("success");
        } catch {
          this.observe("failure");
        }
      }
    } finally {
      this.running = false;
    }
  }
}

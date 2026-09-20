import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseStore } from "../src/cases/store.js";
import { caseStatus, workflowKind, actionsFor } from "../src/cases/catalog.js";
const staff = { guildId: "g", userId: "staff", staff: true };
function fixture(category: string) {
  const dir = mkdtempSync(join(tmpdir(), "hk-workflow-"));
  const store = new CaseStore({
    path: join(dir, "db"),
    guildId: "g",
    key: "11".repeat(32),
    lookupKey: "22".repeat(32),
  });
  let c = store.create(
    { ...staff, staff: false },
    { title: "Synthetic", body: "Test", mode: "anonymous", category },
    "create",
  );
  return {
    store,
    get c() {
      return c;
    },
    act(kind: any) {
      c = store.act(
        staff,
        c.id,
        c.version,
        kind,
        "Test reason",
        String(c.version),
      );
      return c;
    },
    done() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("problem and feedback decisions are distinct, staff-only and terminal decisions close and lock", () => {
  for (const category of [
    "bug",
    "billing",
    "account",
    "card_error",
    "review",
    "card_report",
  ]) {
    const f = fixture(category);
    try {
      const feedback = ["review", "card_report"].includes(category);
      assert.equal(workflowKind(category), feedback ? "feedback" : "problem");
      assert.throws(
        () =>
          f.store.act(
            { ...staff, staff: false },
            f.c.id,
            1,
            "pass",
            "Reason",
            "denied",
          ),
        /denied/,
      );
      assert.throws(
        () => f.act(feedback ? "wait_technical" : "discuss"),
        /invalid/,
      );
      if (!feedback) assert.throws(() => f.act("not_adopted"), /invalid/);
      f.act(feedback ? "discuss" : "wait_technical");
      f.act("reply");
      assert.equal(
        f.c.state,
        feedback ? "under_discussion" : "waiting_technical",
      );
      const c = f.act(feedback ? "not_adopted" : "pass");
      assert.equal(c.state, "closed");
      assert.equal(c.locked, true);
      assert.equal(c.archived, true);
      assert.equal(caseStatus(c), feedback ? "not_adopted" : "passed");
      assert.ok(
        c.events.some((e) => e.kind === (feedback ? "not_adopted" : "pass")),
      );
      f.act("reopen");
      assert.equal(f.c.resolution, null);
      assert.equal(caseStatus(f.c), "in_progress");
      f.act("pass");
      assert.equal(caseStatus(f.c), "passed");
      assert.deepEqual(actionsFor(f.c), []);
    } finally {
      f.done();
    }
  }
});
test("yellow reflects unfinished physical state without treating auto archive as resolution", () => {
  for (const category of ["bug", "review"]) {
    const f = fixture(category);
    try {
      f.act("archive");
      assert.equal(caseStatus(f.c), "submitted");
      f.act("restore");
      f.act("lock");
      assert.equal(
        caseStatus(f.c),
        category === "review" ? "paused" : "submitted",
      );
      f.act("archive");
      assert.equal(caseStatus(f.c), "paused");
      assert.equal(f.c.state, "submitted");
      assert.equal(f.c.resolution, null);
      f.act("restore");
      assert.equal(caseStatus(f.c), "submitted");
      f.act("close");
      assert.equal(caseStatus(f.c), "closed");
    } finally {
      f.done();
    }
  }
});
test("observed thread state is version checked, idempotent and cannot overwrite pending projections or decide outcomes", () => {
  const f = fixture("review");
  try {
    const c = f.c;
    f.store.thread(c.id, "thread");
    assert.equal(
      f.store.observeThread(c.id, c.version, { archived: false, locked: true }),
      false,
    );
    f.store.delivered(c.id, 1, "thread");
    f.store.synced(c.id, 1);
    assert.equal(
      f.store.observeThread(c.id, 1, { archived: false, locked: true }),
      true,
    );
    const updated = f.store.projection(c.id);
    assert.equal(caseStatus(updated), "paused");
    assert.equal(updated.resolution, null);
    assert.equal(
      f.store.observeThread(c.id, 1, { archived: false, locked: false }),
      false,
    );
    f.store.synced(c.id, updated.version);
    assert.equal(
      f.store.observeThread(c.id, updated.version, {
        archived: false,
        locked: true,
      }),
      false,
    );
    assert.equal(
      f.store.read({ ...staff, staff: false }, c.id).events.length,
      1,
    );
  } finally {
    f.done();
  }
});

test("delivery applies terminal lock/archive and observed flags never change the staff decision", async () => {
  const { DeliveryWorker } = await import("../src/cases/delivery.js");
  const f = fixture("review");
  try {
    f.act("not_adopted");
    let flags: any;
    const worker = new DeliveryWorker(f.store, {
      verify: async () => {},
      findThread: async () => null,
      createThread: async () => "thread",
      findMessage: async () => null,
      sendEvent: async () => "message",
      sync: async (c) => {
        flags = {
          locked: c.locked,
          archived: c.archived,
          status: caseStatus(c),
        };
      },
      remove: async () => {},
    });
    await worker.run();
    assert.deepEqual(flags, {
      locked: true,
      archived: true,
      status: "not_adopted",
    });
    assert.equal(f.store.pending().length, 0);
    const c = f.store.projection(f.c.id);
    f.store.observeThread(c.id, c.version, { locked: false, archived: false });
    assert.equal(caseStatus(f.store.projection(c.id)), "not_adopted");
  } finally {
    f.done();
  }
});

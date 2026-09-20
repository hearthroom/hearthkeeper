import test from "node:test";
import assert from "node:assert/strict";
import { CaseInteractions } from "../src/cases/interactions.js";
import { CaseStore } from "../src/cases/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hk-ui-"));
  const store = new CaseStore({
    path: join(dir, "db"),
    guildId: "g",
    key: "11".repeat(32),
    lookupKey: "22".repeat(32),
  });
  let staff = false;
  const ui = new CaseInteractions(store, "g", "app", async (i: any) => ({
    guildId: i.guildId,
    userId: i.user.id,
    staff,
  }));
  return {
    store,
    ui,
    setStaff: () => (staff = true),
    done() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function interaction(
  kind = "command",
  customId = "",
  commandName = "hearthkeeper",
) {
  const replies: any[] = [];
  return {
    guildId: "g",
    applicationId: "app",
    user: { id: "member" },
    locale: "zh-TW",
    id: Math.random().toString(),
    commandName,
    customId,
    replies,
    deferred: false,
    replied: false,
    isChatInputCommand: () => kind === "command",
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    reply: async function (x: any) {
      this.replied = true;
      replies.push(x);
    },
    deferReply: async function (x: any) {
      this.deferred = true;
      replies.push(x);
    },
    editReply: async (x: any) => {
      replies.push(x);
    },
    showModal: async (x: any) => {
      replies.push(x);
    },
    fields: {
      getTextInputValue: (key: string): string =>
        key === "title" ? "Feedback" : "Message body",
    },
  };
}
test("menu offers working feedback and private progress entry; consent modal explains anonymity and retention", async () => {
  const f = setup();
  try {
    const menu = interaction();
    await f.ui.handle(menu);
    assert.match(JSON.stringify(menu.replies), /提出回報/);
    assert.match(JSON.stringify(menu.replies), /我的回報/);
    assert.equal(menu.replies[0].flags, 64);
    const i = interaction("button", "hk:new:anonymous");
    await f.ui.handle(i);
    assert.match(JSON.stringify(i.replies), /90/);
    assert.match(JSON.stringify(i.replies), /維運/);
    assert.equal(i.replies[0].custom_id, "hk:create:anonymous");
  } finally {
    f.done();
  }
});
test("modal submission persists once and member lookup never returns another member or staff notes", async () => {
  const f = setup();
  try {
    const i = interaction("modal", "hk:create:anonymous");
    await f.ui.handle(i);
    await f.ui.handle({ ...i, replies: [] });
    assert.equal(
      f.store.list({ guildId: "g", userId: "member", staff: false }).length,
      1,
    );
    const other = interaction("command", "", "myreports");
    other.user.id = "other";
    await f.ui.handle(other);
    assert.match(JSON.stringify(other.replies), /尚無/);
    assert.doesNotMatch(JSON.stringify(other.replies), /Message body/);
  } finally {
    f.done();
  }
});
test("DM, foreign guild, wrong application and unapproved staff cannot use case workflow", async () => {
  const f = setup();
  try {
    for (const patch of [
      { guildId: null },
      { guildId: "other" },
      { applicationId: "other" },
    ]) {
      const i = { ...interaction(), ...patch };
      assert.equal(await f.ui.handle(i), false);
      assert.equal(i.replies.length, 0);
    }
    const i = interaction("command", "", "cases");
    await f.ui.handle(i);
    assert.match(JSON.stringify(i.replies), /權限/);
  } finally {
    f.done();
  }
});
test("member can read all of a long formatted report without truncation", async () => {
  const f = setup();
  try {
    const body = "*".repeat(1390) + "ENDMARKER";
    const i = interaction("modal", "hk:create:anonymous");
    i.fields.getTextInputValue = (key: string) =>
      key === "title" ? "Title" : body;
    await f.ui.handle(i);
    const last = i.replies.at(-1);
    assert.ok(
      (last.content ?? last.embeds?.[0]?.description).includes("ENDMARKER"),
    );
  } finally {
    f.done();
  }
});

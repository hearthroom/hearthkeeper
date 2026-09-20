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
      [last.content, ...last.embeds.map((e: any) => e.description)].join("").includes("ENDMARKER"),
    );
  } finally {
    f.done();
  }
});
test("default menu exposes exactly the six report categories and preserves choice through consent and modal", async () => {
  const f = setup();
  try {
    const menu = interaction();
    await f.ui.handle(menu);
    const buttons = menu.replies[0].components.flatMap(
      (r: any) => r.components,
    );
    assert.equal(
      buttons.filter((b: any) => b.custom_id?.startsWith("hk:category:"))
        .length,
      6,
    );
    const choose = interaction("button", "hk:category:billing");
    await f.ui.handle(choose);
    assert.match(JSON.stringify(choose.replies), /hk:new:anonymous:billing/);
    const modal = interaction("modal", "hk:create:anonymous:billing");
    await f.ui.handle(modal);
    assert.equal(
      f.store.list({ guildId: "g", userId: "member", staff: false })[0]
        ?.category,
      "billing",
    );
  } finally {
    f.done();
  }
});
test("staff get a separate forum-management panel while ordinary members are denied", async () => {
  const f = setup();
  try {
    const actor = { guildId: "g", userId: "member", staff: true };
    const c = f.store.create(
      actor,
      { title: "Test", body: "Body", mode: "anonymous" },
      "setup",
    );
    const code = f.store.action(actor, c.id, "staff_forum", 1, true);
    const denied = interaction("button", "hk:act:" + code);
    await f.ui.handle(denied);
    assert.match(JSON.stringify(denied.replies), /權限/);
    f.setStaff();
    const allowed = interaction("button", "hk:act:" + code);
    await f.ui.handle(allowed);
    const output = JSON.stringify(allowed.replies);
    for (const name of [
      "關閉貼文",
      "鎖定貼文",
      "關閉並鎖定",
      "恢復貼文",
      "等待中",
      "處理中",
      "等待中（技術）",
    ])
      assert.ok(output.includes(name));
  } finally {
    f.done();
  }
});

test("second panel follows case kind and uses guild emoji payloads with explicit terminal effects", async () => {
  for (const category of ["bug", "review"]) {
    const f = setup();
    try {
      f.setStaff();
      const actor = { guildId: "g", userId: "member", staff: true };
      const c = f.store.create(
        actor,
        { title: "Synthetic", body: "Test", mode: "anonymous", category },
        "setup",
      );
      const ui = new CaseInteractions(
        f.store,
        "g",
        "app",
        async () => actor,
        (name: string) => ({ id: "emoji-" + name, name }),
      );
      const code = f.store.action(actor, c.id, "staff_forum", 1, true);
      const i = interaction("button", "hk:act:" + code);
      await ui.handle(i);
      const panel = i.replies.at(-1);
      const buttons = panel.components.flatMap((r: any) => r.components);
      const actions = buttons.map(
        (b: any) => f.store.resolve(actor, b.custom_id.slice(7)).action,
      );
      assert.ok(actions.includes("pass"));
      assert.equal(actions.includes("not_adopted"), category === "review");
      assert.equal(actions.includes("discuss"), category === "review");
      assert.equal(actions.includes("wait_technical"), category === "bug");
      assert.match(panel.content, /自動關閉並鎖定/);
      assert.ok(buttons.some((b: any) => b.emoji?.name === "Passed"));
      assert.ok(buttons.some((b: any) => b.emoji?.name === "Waiting"));
      assert.ok(panel.components.every((r: any) => r.components.length <= 5));
    } finally {
      f.done();
    }
  }
});
test("configured private reports are primary, queue a conversation and reveal only a ready owner link", async () => {
  const f = setup();
  try {
    const ui = new CaseInteractions(
      f.store,
      "g",
      "app",
      async (i) => ({ guildId: "g", userId: i.user.id, staff: false }),
      undefined,
      "parent",
    );
    const choice = interaction("button", "hk:category:bug");
    await ui.handle(choice);
    const first = choice.replies[0].components[0].components[0];
    assert.equal(first.custom_id, "hk:new:identified:bug");
    assert.equal(first.style, 1);
    const i = interaction("modal", "hk:create:identified:bug");
    await ui.handle(i);
    const c = f.store.list({
      guildId: "g",
      userId: "member",
      staff: false,
    })[0]!;
    assert.equal(f.store.privateProjection(c.id)?.parentId, "parent");
    assert.match(JSON.stringify(i.replies), /準備中/);
    assert.doesNotMatch(JSON.stringify(i.replies), /discord.com\/channels/);
    f.store.privateThread(c.id, "thread");
    f.store.privateSynced(c.id, c.version);
    const action = f.store.action(
      { guildId: "g", userId: "member", staff: false },
      c.id,
      "view",
      c.version,
    );
    const view = interaction("button", "hk:act:" + action);
    await ui.handle(view);
    assert.match(
      JSON.stringify(view.replies),
      /https:\/\/discord.com\/channels\/g\/thread/,
    );
    const other = interaction("button", "hk:act:" + action);
    other.user.id = "other";
    await ui.handle(other);
    assert.doesNotMatch(JSON.stringify(other.replies), /discord.com\/channels/);
  } finally {
    f.done();
  }
});

test("archived-thread modal updates its private panel without creating a new thread reply", async () => {
  const f = setup();
  try {
    f.setStaff();
    const actor = { guildId: "g", userId: "member", staff: true };
    const c = f.store.create(actor, {title:"Fixture",body:"Test",mode:"anonymous"}, "create");
    const closed = f.store.act(actor,c.id,c.version,"close","Test complete","close");
    const code = f.store.action(actor,c.id,"reopen",closed.version);
    const i = {
      ...interaction("modal", "hk:submit:" + code),
      isFromMessage: () => true,
      message: {flags:{has:(flag:number)=>flag===64}},
      deferReply: async () => { throw Object.assign(Error("archived"),{code:50083}); },
      deferUpdate: async function () { this.deferred=true; },
    };
    await f.ui.handle(i);
    assert.equal(f.store.read(actor,c.id).state,"in_progress");
    assert.ok(i.deferred);
    assert.equal(i.replies.at(-1).content, "", "replace stale panel status with the new detail");
    assert.match(JSON.stringify(i.replies), /案件重開/);
  } finally { f.done(); }
});

test("modal results never overwrite a public source message", async () => {
  const f=setup();
  try {
    let updated=false;
    const i={...interaction("modal","hk:create:anonymous"),isFromMessage:()=>true,message:{flags:{has:()=>false}},deferUpdate:async()=>{updated=true;}};
    await f.ui.handle(i);
    assert.equal(updated,false);
    assert.equal(i.replies[0].flags,64);
    assert.equal(f.store.list({guildId:"g",userId:"member",staff:false}).length,1);
  } finally {f.done();}
});

test("persistent case panels include a safe parent-channel entry when private conversations are configured", () => {
  const f=setup();
  try {
    const actor={guildId:"g",userId:"member",staff:true};
    const c=f.store.create(actor,{title:"Fixture",body:"Test",mode:"anonymous"},"create");
    const ui=new CaseInteractions(f.store,"g","app",async()=>actor,undefined,"parent");
    for(const archived of [false,true]) {
      const buttons=ui.staffPanel({...c,archived}).flatMap(r=>r.components);
      const link=buttons.find(b=>b.style===5);
      assert.equal(link?.url,"https://discord.com/channels/g/parent");
      assert.equal(link?.custom_id,undefined);
    }
  } finally {f.done();}
});

test("case handler records accepted and denied interactions", async () => {
  const f=setup(); const outcomes: string[]=[];
  try {
    const ui=new CaseInteractions(f.store,"g","app",async()=>({guildId:"g",userId:"member",staff:false}),undefined,undefined,(kind,outcome)=>outcomes.push(kind+":"+outcome));
    await ui.handle(interaction("modal","hk:create:anonymous"));
    await ui.handle(interaction("command","","cases"));
    assert.deepEqual(outcomes,["modal:success","command:denied"]);
  } finally {f.done();}
});

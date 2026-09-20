import {
  categories,
  categoryName,
  forumActions,
  statusActions,
  decisionActions,
  actionsFor,
  caseStatus,
  workflowKind,
  actionStatus,
  statusEmojiNames,
} from "./catalog.js";
import {
  CaseStore,
  CaseError,
  type Actor,
  type CaseView,
  type Action,
} from "./store.js";
const row = (components: any[]) => ({ type: 1, components });
const button = (label: string, id: string, style = 2) => ({
  type: 2,
  style,
  label,
  custom_id: id,
});
const clean = (s: string) =>
  s
    .replace(/([\\`*_~|>])/g, "\\$1")
    .replace(/https?:\/\/[^\s]+/g, (m) => `<${m}>`);
export const stateName = (state: string, zh = true) =>
  ({
    submitted: zh ? "等待中" : "Waiting",
    in_progress: zh ? "處理中" : "In progress",
    waiting_technical: zh ? "等待中（技術）" : "Waiting for technology",
    under_discussion: zh ? "討論中" : "Under discussion",
    paused: zh ? "暫停處理" : "Paused",
    passed: "PASS",
    not_adopted: zh ? "未採納" : "Not adopted",
    waiting_member: zh ? "待補充" : "Waiting for you",
    closed: zh ? "已結案" : "Closed",
  })[state] ?? state;
export const eventName = (kind: string, zh = true) =>
  ({
    submitted: zh ? "回報內容" : "Report",
    claim: zh ? "社管已認領" : "Claimed",
    reply: zh ? "社管回覆" : "Staff reply",
    request_info: zh ? "社管請你補充" : "More information requested",
    supplement: zh ? "成員補充" : "Member update",
    close: zh ? "結案結果" : "Resolution",
    reopen: zh ? "案件重開" : "Reopened",
    request_close: zh ? "申請結案" : "Close requested",
    request_reopen: zh ? "申請重開" : "Reopen requested",
    reject: zh ? "申請未通過" : "Request declined",
    archive: zh ? "關閉貼文" : "Close post",
    lock: zh ? "鎖定貼文" : "Lock post",
    archive_lock: zh ? "關閉並鎖定" : "Close and lock",
    set_waiting: zh ? "等待中" : "Waiting",
    set_processing: zh ? "處理中" : "In progress",
    wait_technical: zh ? "等待中（技術）" : "Waiting for technology",
    discuss: zh ? "討論中" : "Discuss",
    pass: zh ? "PASS・關閉並鎖定" : "PASS · close and lock",
    not_adopted: zh ? "未採納・關閉並鎖定" : "Not adopted · close and lock",
    thread_state: zh ? "Discord 貼文狀態更新" : "Discord post state updated",
    restore: zh ? "恢復貼文" : "Restore post",
  })[kind] ?? kind;
export function forumContent(c: CaseView, e: CaseView["events"][number]) {
  if (e.seq === 1) {
    const date = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(c.createdAt);
    return `${date}（UTC+8）｜${e.body}${c.mode === "identified" ? `\n回報帳號：${c.reporter}` : ""}`;
  }
  return `**HK-${c.id.slice(0, 8)} · ${eventName(e.kind)}**\n${clean(e.body)}${e.seq === 1 && c.mode === "identified" ? `\n回報帳號：${c.reporter}` : ""}\n\n\`hk:${e.deliveryKey}\``;
}
export class CaseInteractions {
  constructor(
    private store: CaseStore,
    private guildId: string,
    private appId: string,
    private actor: (interaction: any) => Promise<Actor>,
    private emoji: (
      name: string,
    ) => { id: string; name: string; animated?: boolean } | undefined = () =>
      undefined,
  ) {}
  private payload(content: string, components: any[] = []) {
    return { content, components, allowedMentions: { parse: [] }, flags: 64 };
  }
  private async send(i: any, p: any) {
    if (i.deferred || i.replied) {
      const { flags, ...edit } = p;
      await i.editReply(edit);
    } else await i.reply(p);
  }
  private code(a: Actor, c: CaseView, kind: string, shared = false) {
    return "hk:act:" + this.store.action(a, c.id, kind, c.version, shared);
  }
  staffPanel(c: CaseView) {
    const actor = { guildId: this.guildId, userId: this.appId, staff: true };
    return [
      row([
        button("處理案件", this.code(actor, c, "staff_view", true), 1),
        button("貼文管理", this.code(actor, c, "staff_forum", true)),
      ]),
    ];
  }
  private statusName(c: CaseView, zh: boolean) {
    const state = caseStatus(c),
      emoji = this.emoji(statusEmojiNames[state]!);
    return `${emoji ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}> ` : ""}${stateName(state, zh)}`;
  }
  private statusButton(a: Actor, c: CaseView, kind: string, zh: boolean) {
    const emoji =
      kind === "lock" && workflowKind(c.category) === "problem"
        ? undefined
        : this.emoji(statusEmojiNames[actionStatus[kind]!]!);
    return {
      ...button(
        eventName(kind, zh),
        this.code(a, c, kind),
        kind === "pass" ? 3 : kind === "not_adopted" ? 4 : 2,
      ),
      ...(emoji ? { emoji } : {}),
    };
  }
  private menu(zh: boolean) {
    return this.payload(
      zh
        ? "**爐邊管家**\n選擇分類提出回報。\n問題：功能異常、儲值、帳號、角色卡錯誤。\n回饋：審核疑問、角色卡檢舉。\n回報會由社管處理，進度與回覆可在「我的回報」查看。"
        : "**Hearthkeeper**\nProblems: bugs, top-ups, accounts and card errors. Feedback: review questions and card reports. Moderators handle your reports. Check My reports for updates.",
      [
        ...[categories.slice(0, 4), categories.slice(4)].map((group) =>
          row(
            group.map((c) =>
              button(zh ? c.zh : c.en, "hk:category:" + c.id, 1),
            ),
          ),
        ),
        row([
          button(zh ? "我的回報" : "My reports", "hk:mine"),
          button(zh ? "社管案件" : "Staff cases", "hk:staff"),
        ]),
        row([
          {
            type: 2,
            style: 5,
            label: zh ? "前往社群站" : "Visit HearthRoom",
            url: "https://hearthroom.club",
          },
          {
            type: 2,
            style: 5,
            label: zh ? "閱讀寫卡指南" : "Read the guide",
            url: "https://hearthroom.club/guide",
          },
        ]),
      ],
    );
  }
  private consent(zh: boolean, category = "general") {
    return this.payload(
      zh
        ? "**選擇回報方式**\n匿名回報不向社管顯示帳號；私密回報會顯示帳號。機器人仍保存身分對應，維運者與 Discord 可接觸資料。\n\n你自行填寫的姓名或連結可能透露身分。案件結案後保存 90 天；論壇刪除若遇錯誤會重試。每人最多 3 個未結案回報，送出間隔 60 秒。\n\n回報會交由這個伺服器的社管查看；若涉及社管本人，請另找可信任的承辦人。"
        : "**Choose report privacy**\nAnonymous reports hide your account from moderators; identified reports show it. The bot keeps an identity mapping accessible to operators and Discord. Names and links you write may reveal you.\n\nCases are retained for 90 days after closure; failed forum deletions are retried. Maximum 3 open reports, 60 seconds between submissions. Reports go to this server’s moderators. If your report concerns a moderator, contact a trusted handler separately.",
      [
        row([
          button(
            zh ? "匿名回報" : "Anonymous report",
            "hk:new:anonymous:" + category,
            1,
          ),
          button(
            zh ? "私密回報（顯示帳號）" : "Identified report",
            "hk:new:identified:" + category,
          ),
        ]),
      ],
    );
  }
  private async forumPanel(i: any, a: Actor, c: CaseView) {
    if (!a.staff) throw new CaseError("denied");
    const zh = i.locale === "zh-TW";
    await this.send(
      i,
      this.payload(
        zh
          ? `**貼文管理・${workflowKind(c.category) === "feedback" ? "回饋" : "問題"}**\n${this.statusName(c, zh)}\n${c.archived ? "已關閉" : "開啟中"} · ${c.locked ? "已鎖定" : "未鎖定"}\n關閉會封存貼文；鎖定限制一般成員重新開啟，不會讓開啟中的貼文停止收訊。一般貼文操作不會結案；未完成時鎖定${workflowKind(c.category) === "problem" ? "並關閉" : ""}會顯示黃色。PASS${workflowKind(c.category) === "feedback" ? " 或未採納" : ""}會自動關閉並鎖定。已結案案件須先重開案件。`
          : `**Post management**\n${this.statusName(c, zh)}\n${c.archived ? "Closed" : "Open"} · ${c.locked ? "Locked" : "Unlocked"}\nClosing archives the post. Locking restricts reopening; it does not stop replies in an active post. Post controls do not resolve the case. PASS / Not adopted close and lock automatically. Reopen a resolved case first.`,
        c.state === "closed"
          ? [
              row([
                button(
                  zh ? "重開案件" : "Reopen case",
                  this.code(a, c, "reopen"),
                ),
              ]),
            ]
          : [
              row(
                actionsFor(c).map((kind) => this.statusButton(a, c, kind, zh)),
              ),
              row(
                forumActions.map((kind) => this.statusButton(a, c, kind, zh)),
              ),
            ],
      ),
    );
  }
  private modal(id: string, title: string, zh: boolean, create = false) {
    const fields = create
      ? [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "title",
                label: zh ? "標題" : "Title",
                style: 1,
                min_length: 1,
                max_length: 80,
                required: true,
              },
            ],
          },
        ]
      : [];
    fields.push({
      type: 1,
      components: [
        {
          type: 4,
          custom_id: "body",
          label: zh
            ? create
              ? "內容（含選填連結）"
              : "內容或處理理由"
            : "Details / reason",
          style: 2,
          min_length: 1,
          max_length: 1400,
          required: true,
          ...(create
            ? {
                placeholder: zh
                  ? "結案後保存 90 天；維運者可接觸資料，勿填不必要的個資。"
                  : "Retained 90 days after closure; operators can access data. Avoid unnecessary personal data.",
              }
            : {}),
        },
      ],
    } as any);
    return { custom_id: id, title, components: fields };
  }
  private async list(i: any, a: Actor, offset: number) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
      throw new CaseError("invalid");
    const zh = i.locale === "zh-TW",
      cases = this.store.list(a, offset);
    const rows = cases.map((c) =>
      row([
        button(
          `${stateName(caseStatus(c), zh)} · ${c.title}`.slice(0, 80),
          this.code(a, c, a.staff ? "staff_view" : "view"),
        ),
      ]),
    );
    // Discord supports five action rows: four cases per page, with fixed navigation.
    const page = cases.slice(0, 4);
    const prefix = a.staff ? "hk:staff:" : "hk:mine:";
    const nav = [];
    if (offset > 0)
      nav.push(
        button(zh ? "上一頁" : "Previous", prefix + Math.max(0, offset - 4)),
      );
    if (cases.length > 4)
      nav.push(button(zh ? "下一頁" : "Next", prefix + (offset + 4)));
    if (nav.length) rows.splice(4, rows.length - 4, row(nav));
    else rows.splice(4);
    await this.send(
      i,
      this.payload(
        page.length
          ? zh
            ? "選擇案件查看進度與回覆。"
            : "Select a case to view updates."
          : zh
            ? "尚無回報。"
            : "No reports yet.",
        rows,
      ),
    );
  }
  private async detail(i: any, a: Actor, c: CaseView, page?: number) {
    const zh = i.locale === "zh-TW";
    const index = Math.max(
      0,
      Math.min(page ?? c.events.length - 1, c.events.length - 1),
    );
    const event = c.events[index]!;
    let content = `**HK-${c.id.slice(0, 8)} · ${clean(c.title)}**\n${categoryName(c.category, zh)} · ${this.statusName(c, zh)} · ${c.mode === "anonymous" ? (zh ? "匿名" : "Anonymous") : zh ? "私密" : "Identified"}${c.sync === "pending" ? (zh ? " · 論壇同步待處理" : " · Forum sync pending") : ""}\n\n**${eventName(event.kind, zh)} (${index + 1}/${c.events.length})**\n${clean(event.body)}`;
    if (c.request)
      content +=
        "\n\n" +
        (zh ? "成員申請待社管決定。" : "Member request awaiting a decision.");
    const nav = [];
    if (index > 0)
      nav.push(
        button(
          zh ? "較早紀錄" : "Earlier",
          this.code(a, c, (a.staff ? "staff_page:" : "page:") + (index - 1)),
        ),
      );
    if (index < c.events.length - 1)
      nav.push(
        button(
          zh ? "較新紀錄" : "Newer",
          this.code(a, c, (a.staff ? "staff_page:" : "page:") + (index + 1)),
        ),
      );
    const actions: any[] = [];
    const add = (label: string, en: string, kind: string, style = 2) =>
      actions.push(button(zh ? label : en, this.code(a, c, kind), style));
    if (a.staff) {
      if (c.state === "closed") add("重開案件", "Reopen", "reopen");
      else {
        if (c.state === "submitted") add("認領", "Claim", "claim");
        add("回覆成員", "Reply", "reply", 1);
        add("要求補充", "Request details", "request_info");
      }
      if (c.request) add("拒絕申請", "Decline request", "reject");
    } else {
      if (c.state !== "closed") add("補充內容", "Add details", "supplement", 1);
      if (!c.request)
        add(
          c.state === "closed" ? "申請重開" : "申請結案",
          c.state === "closed" ? "Request reopen" : "Request close",
          c.state === "closed" ? "request_reopen" : "request_close",
        );
    }
    const result: any = this.payload("", [
      ...(nav.length ? [row(nav)] : []),
      ...(actions.length ? [row(actions)] : []),
      ...(a.staff
        ? [
            row([
              button(
                zh ? "貼文管理" : "Post management",
                this.code(a, c, "staff_forum"),
              ),
            ]),
          ]
        : []),
    ]);
    delete result.content;
    result.embeds = [{ description: content }];
    await this.send(i, result);
  }
  async handle(i: any): Promise<boolean> {
    if (i.guildId !== this.guildId || i.applicationId !== this.appId)
      return false;
    const command = i.isChatInputCommand(),
      buttonInput = i.isButton?.(),
      modal = i.isModalSubmit?.();
    if (!command && !buttonInput && !modal) return false;
    const id = String(i.customId ?? "");
    if (
      command &&
      !["hearthkeeper", "feedback", "myreports", "cases"].includes(
        i.commandName,
      )
    )
      return false;
    if (!command && !id.startsWith("hk:")) return false;
    const zh = i.locale === "zh-TW";
    try {
      // Opening a modal must be the initial response, so do no network work on this path.
      if (
        buttonInput &&
        /^hk:new:(anonymous|identified)(:[a-z_]+)?$/.test(id)
      ) {
        const category = id.split(":")[3] ?? "general";
        if (
          category !== "general" &&
          !categories.some((c) => c.id === category)
        )
          throw new CaseError("invalid");
        await i.showModal(
          this.modal(
            id.replace("hk:new:", "hk:create:"),
            zh
              ? id.split(":")[2] === "anonymous"
                ? "匿名回報"
                : "私密回報（顯示帳號）"
              : "Submit report",
            zh,
            true,
          ),
        );
        return true;
      }
      if (command && i.commandName === "hearthkeeper") {
        await this.send(i, this.menu(zh));
        return true;
      }
      if ((command && i.commandName === "feedback") || id === "hk:new") {
        await this.send(i, this.menu(zh));
        return true;
      }
      if (buttonInput && id.startsWith("hk:category:")) {
        const category = id.split(":")[2]!;
        if (!categories.some((c) => c.id === category))
          throw new CaseError("invalid");
        await this.send(i, this.consent(zh, category));
        return true;
      }
      // For action buttons the role check must fit the initial modal response deadline.
      const opensAction = buttonInput && id.startsWith("hk:act:");
      if (!opensAction) await i.deferReply({ flags: 64 });
      let actor = await this.actor(i);
      if (modal && /^hk:create:(anonymous|identified)(:[a-z_]+)?$/.test(id)) {
        actor = { ...actor, staff: false };
        const c = this.store.create(
          actor,
          {
            category: id.split(":")[3] ?? "general",
            title: i.fields.getTextInputValue("title"),
            body: i.fields.getTextInputValue("body"),
            mode: id.split(":")[2] === "anonymous" ? "anonymous" : "identified",
          },
          i.id,
        );
        await this.detail(i, actor, c);
        return true;
      }
      const listMine =
        (command && i.commandName === "myreports") ||
        id === "hk:mine" ||
        id.startsWith("hk:mine:");
      const listStaff =
        (command && i.commandName === "cases") ||
        id === "hk:staff" ||
        id.startsWith("hk:staff:");
      if (listMine || listStaff) {
        if (listStaff && !actor.staff) throw new CaseError("denied");
        actor = { ...actor, staff: listStaff };
        await this.list(i, actor, Number(id.split(":")[2] ?? 0));
        return true;
      }
      const code = id.split(":")[2] ?? "";
      const action = this.store.resolve(actor, code);
      const staffAction =
        action.action.startsWith("staff_") ||
        [
          "claim",
          "reply",
          "request_info",
          "close",
          "reopen",
          "reject",
          ...forumActions,
          ...statusActions,
          ...decisionActions,
        ].includes(action.action);
      actor = { ...actor, staff: staffAction && actor.staff };
      if (staffAction && !actor.staff) throw new CaseError("denied");
      if (action.action === "staff_forum") {
        await this.forumPanel(i, actor, this.store.read(actor, action.caseId));
        return true;
      }
      if (
        action.action === "view" ||
        action.action === "staff_view" ||
        action.action.startsWith("page:") ||
        action.action.startsWith("staff_page:")
      ) {
        await this.detail(
          i,
          actor,
          this.store.read(actor, action.caseId),
          action.action.includes(":")
            ? Number(action.action.split(":")[1])
            : undefined,
        );
        return true;
      }
      if (buttonInput && action.action !== "claim") {
        await i.showModal(
          this.modal("hk:submit:" + code, eventName(action.action, zh), zh),
        );
        return true;
      }
      if (buttonInput || modal) {
        const body = modal ? i.fields.getTextInputValue("body") : "";
        const c = this.store.act(
          actor,
          action.caseId,
          action.version,
          action.action as Action,
          body,
          i.id,
        );
        await this.detail(i, actor, c);
        return true;
      }
      throw new CaseError("invalid");
    } catch (e) {
      const code = e instanceof CaseError ? e.message : "unavailable";
      const messages: Record<string, [string, string]> = {
        denied: [
          "你沒有這個案件的操作權限。",
          "You do not have access to this case.",
        ],
        stale: [
          "案件已有更新，請重新開啟案件後再送出。",
          "The case changed. Reopen it before submitting.",
        ],
        expired: [
          "這個操作已過期，請從選單重新開啟案件。",
          "This action expired. Open the case again.",
        ],
        closed: [
          "案件已結案，請從「我的回報」申請重開。",
          "This case is closed. Request reopening from My reports.",
        ],
        reply_cooldown: [
          "補充內容間隔需滿 5 秒，請稍後再送出。",
          "Wait 5 seconds between updates.",
        ],
        cooldown: [
          "回報間隔需滿 60 秒，請稍後再送出。",
          "Wait 60 seconds between reports.",
        ],
        limit: [
          "你已有 3 個未結案回報，請先在既有案件補充。",
          "You already have 3 open reports. Add details to an existing case.",
        ],
        pending: [
          "社管正在處理上一個申請，請等候結果。",
          "Your previous request is awaiting a decision.",
        ],
        invalid: [
          "內容未符合表單要求，請檢查後再送出。",
          "Check the form requirements and submit again.",
        ],
      };
      let content = (messages[code] ?? [
        "這次未能完成操作，請從「我的回報」確認是否已收到。",
        "The operation could not complete. Check My reports before retrying.",
      ])[zh ? 0 : 1];
      if (modal) {
        const draft = i.fields.getTextInputValue("body");
        content +=
          "\n\n" +
          (zh
            ? "本次填寫內容（可複製後重送）："
            : "Your draft (copy before retrying):") +
          "\n" +
          draft.slice(0, 1400);
      }
      try {
        await this.send(i, this.payload(content));
      } catch {
        /* Never log private interaction payloads. */
      }
      return true;
    }
  }
}

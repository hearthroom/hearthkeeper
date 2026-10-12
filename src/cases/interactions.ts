import { MessageFlags } from "discord.js";
import { localize, userLanguage, type UserLanguage } from "../locale.js";
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
type LanguageInput = UserLanguage | boolean;
const languageOf = (language: LanguageInput): UserLanguage =>
  typeof language === "boolean" ? (language ? "zh-Hant" : "en") : language;
const text = (
  language: LanguageInput,
  traditional: string,
  simplified: string,
  english: string,
) => localize(languageOf(language), traditional, simplified, english);

export const stateName = (state: string, language: LanguageInput = true) =>
  ({
    submitted: text(language, "等待中", "等待中", "Waiting"),
    in_progress: text(language, "處理中", "处理中", "In progress"),
    waiting_technical: text(language, "等待中（技術）", "等待中（技术）", "Waiting for technology"),
    under_discussion: text(language, "討論中", "讨论中", "Under discussion"),
    paused: text(language, "暫停處理", "暂停处理", "Paused"),
    passed: "PASS",
    not_adopted: text(language, "未採納", "未采纳", "Not adopted"),
    waiting_member: text(language, "待補充", "待补充", "Waiting for you"),
    closed: text(language, "已結案", "已结案", "Closed"),
  })[state] ?? state;
export const eventName = (kind: string, language: LanguageInput = true) =>
  ({
    submitted: text(language, "回報內容", "反馈内容", "Report"),
    claim: text(language, "社管已認領", "社管已认领", "Claimed"),
    reply: text(language, "社管回覆", "社管回复", "Staff reply"),
    request_info: text(language, "社管請你補充", "社管请你补充", "More information requested"),
    supplement: text(language, "成員補充", "成员补充", "Member update"),
    close: text(language, "結案結果", "结案结果", "Resolution"),
    reopen: text(language, "案件重開", "案件重开", "Reopened"),
    request_close: text(language, "申請結案", "申请结案", "Close requested"),
    request_reopen: text(language, "申請重開", "申请重开", "Reopen requested"),
    reject: text(language, "申請未通過", "申请未通过", "Request declined"),
    archive: text(language, "關閉貼文", "关闭帖子", "Close post"),
    lock: text(language, "鎖定貼文", "锁定帖子", "Lock post"),
    archive_lock: text(language, "關閉並鎖定", "关闭并锁定", "Close and lock"),
    set_waiting: text(language, "等待中", "等待中", "Waiting"),
    set_processing: text(language, "處理中", "处理中", "In progress"),
    wait_technical: text(language, "等待中（技術）", "等待中（技术）", "Waiting for technology"),
    discuss: text(language, "討論中", "讨论中", "Discuss"),
    pass: text(language, "PASS・關閉並鎖定", "PASS・关闭并锁定", "PASS · close and lock"),
    not_adopted: text(language, "未採納・關閉並鎖定", "未采纳・关闭并锁定", "Not adopted · close and lock"),
    thread_state: text(language, "Discord 貼文狀態更新", "Discord 帖子状态更新", "Discord post state updated"),
    restore: text(language, "恢復貼文", "恢复帖子", "Restore post"),
    shipped: text(language, "已上線", "已上线", "Shipped"),
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
/**
 * The same event as the reporter's private thread shows it. The reporter reads this thread, so it
 * carries no delivery key (the private thread finds its messages by the embed footer) and names
 * the reporter as a mention instead of a raw account number. The case number stays: members see
 * it in their own case viewer too.
 */
export function threadContent(c: CaseView, e: CaseView["events"][number]) {
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
    return `${date}（UTC+8）｜${e.body}${c.mode === "identified" && c.reporter ? `\n回報帳號：<@${c.reporter}>` : ""}`;
  }
  return `**HK-${c.id.slice(0, 8)} · ${eventName(e.kind)}**\n${clean(e.body)}`;
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
    private privateParentId?: string,
    private observe: (kind: "command" | "button" | "modal", outcome: "success" | "failure" | "denied") => void = () => {},
    private site: string = "https://sukisuki.ai",
  ) {}
  private payload(content: string, components: any[] = []) {
    return { content, embeds: [], components, allowedMentions: { parse: [] }, flags: 64 };
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
        ...(this.privateParentId ? [{
          type: 2, style: 5, label: "案件入口",
          url: `https://discord.com/channels/${this.guildId}/${this.privateParentId}`,
        }] : []),
      ]),
    ];
  }
  private statusName(c: CaseView, language: UserLanguage) {
    const state = caseStatus(c),
      emoji = this.emoji(statusEmojiNames[state]!);
    return `${emoji ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}> ` : ""}${stateName(state, language)}`;
  }
  private statusButton(a: Actor, c: CaseView, kind: string, language: UserLanguage) {
    const emoji =
      kind === "lock" && workflowKind(c.category) === "problem"
        ? undefined
        : this.emoji(statusEmojiNames[actionStatus[kind]!]!);
    return {
      ...button(
        eventName(kind, language),
        this.code(a, c, kind),
        kind === "pass" ? 3 : kind === "not_adopted" ? 4 : 2,
      ),
      ...(emoji ? { emoji } : {}),
    };
  }
  private menu(language: UserLanguage) {
    return this.payload(
      text(
        language,
        "**蘇綺**\n選擇分類提出回報吧。\n問題：功能異常、儲值、帳號、角色卡錯誤。\n回饋：審核疑問、角色卡檢舉。\n社管會處理回報，進度與回覆都能在「我的回報」查看。",
        "**苏绮**\n选择分类提交反馈吧。\n问题：功能异常、充值、账号、角色卡错误。\n反馈：审核疑问、角色卡举报。\n社管会处理反馈，进度与回复都能在“我的反馈”查看。",
        "**Suki**\nChoose a category and send your report. Problems cover bugs, top-ups, accounts and card errors; feedback covers review questions and card reports. Moderators will take care of it, and you can check My reports for updates.",
      ),
      [
        ...[categories.slice(0, 4), categories.slice(4)].map((group) =>
          row(
            group.map((c) =>
              button(
                text(language, c.zh, c.zhHans, c.en),
                "hk:category:" + c.id,
                1,
              ),
            ),
          ),
        ),
        row([
          button(text(language, "我的回報", "我的反馈", "My reports"), "hk:mine"),
          button(text(language, "社管案件", "社管案件", "Staff cases"), "hk:staff"),
        ]),
        row([
          {
            type: 2,
            style: 5,
            label: text(language, "前往社群站", "前往社群站", "Visit HearthRoom"),
            url: this.site,
          },
          {
            type: 2,
            style: 5,
            label: text(language, "閱讀寫卡指南", "阅读写卡指南", "Read the guide"),
            url: this.site + "/guide",
          },
        ]),
      ],
    );
  }
  private consent(language: UserLanguage, category = "general") {
    const direct = this.privateParentId
      ? text(
          language,
          "私密回報會建立你與社管的私人討論串，可直接交談及傳附件；社管能看到你的 Discord 帳號。討論串準備期間仍可從「我的回報」補充。\n\n",
          "私密反馈会建立你与社管的私人讨论串，可以直接交谈和发送附件；社管能看到你的 Discord 账号。讨论串准备期间仍可从“我的反馈”补充。\n\n",
          "Private reports open a conversation with moderators where you can chat and attach files. Moderators can see your Discord account. My reports remains available while the conversation is being prepared.\n\n",
        )
      : "";
    return this.payload(
      direct +
        text(
          language,
          "**選擇回報方式**\n匿名回報不向社管顯示帳號；私密回報會顯示帳號。機器人仍保存身分對應，維運者與 Discord 可接觸資料。\n\n你自行填寫的姓名或連結可能透露身分。案件結案後保存 90 天；論壇刪除若遇錯誤會重試。每人最多 3 個未結案回報，送出間隔 60 秒。\n\n回報會交由這個伺服器的社管查看；若涉及社管本人，請另找可信任的承辦人。",
          "**选择反馈方式**\n匿名反馈不会向社管显示账号；私密反馈会显示账号。机器人仍会保存身份对应关系，运维人员与 Discord 可以接触数据。\n\n你自行填写的姓名或链接可能透露身份。案件结案后保存 90 天；论坛删除遇到错误时会重试。每人最多有 3 个未结案反馈，提交间隔为 60 秒。\n\n反馈会交给这个服务器的社管查看；如果涉及社管本人，请另找可信任的处理人。",
          "**Choose report privacy**\nAnonymous reports hide your account from moderators; identified reports show it. The bot keeps an identity mapping accessible to operators and Discord. Names and links you write may reveal you.\n\nCases are retained for 90 days after closure; failed forum deletions are retried. Maximum 3 open reports, 60 seconds between submissions. Reports go to this server’s moderators. If your report concerns a moderator, contact a trusted handler separately.",
        ),
      [
        row([
          button(
            text(language, "提出私密回報", "提交私密反馈", "Submit private report"),
            "hk:new:identified:" + category,
            1,
          ),
          button(
            text(language, "改用匿名代轉", "改用匿名转交", "Use anonymous relay"),
            "hk:new:anonymous:" + category,
          ),
        ]),
      ],
    );
  }
  private async forumPanel(i: any, a: Actor, c: CaseView) {
    if (!a.staff) throw new CaseError("denied");
    const language = userLanguage(i.locale);
    await this.send(
      i,
      this.payload(
        text(
          language,
          `**貼文管理・${workflowKind(c.category) === "feedback" ? "回饋" : "問題"}**\n${this.statusName(c, language)}\n${c.archived ? "已關閉" : "開啟中"} · ${c.locked ? "已鎖定" : "未鎖定"}\n關閉會封存貼文；鎖定會限制一般成員發言及重新開啟。一般貼文操作不會結案；未完成時鎖定${workflowKind(c.category) === "problem" ? "並關閉" : ""}會顯示黃色。PASS${workflowKind(c.category) === "feedback" ? " 或未採納" : ""}會自動關閉並鎖定。已結案案件須先重開案件。`,
          `**帖子管理・${workflowKind(c.category) === "feedback" ? "反馈" : "问题"}**\n${this.statusName(c, language)}\n${c.archived ? "已关闭" : "开启中"} · ${c.locked ? "已锁定" : "未锁定"}\n关闭会归档帖子；锁定会限制普通成员发言和重新开启。普通帖子操作不会结案；未完成时锁定${workflowKind(c.category) === "problem" ? "并关闭" : ""}会显示黄色。PASS${workflowKind(c.category) === "feedback" ? " 或未采纳" : ""}会自动关闭并锁定。已结案案件需要先重开。`,
          `**Post management**\n${this.statusName(c, language)}\n${c.archived ? "Closed" : "Open"} · ${c.locked ? "Locked" : "Unlocked"}\nClosing archives the post. Locking restricts member replies and reopening. Post controls do not resolve the case. PASS / Not adopted close and lock automatically. Reopen a resolved case first.`,
        ),
        c.state === "closed"
          ? [
              row([
                button(
                  text(language, "重開案件", "重开案件", "Reopen case"),
                  this.code(a, c, "reopen"),
                ),
              ]),
            ]
          : [
              row(
                actionsFor(c).map((kind) => this.statusButton(a, c, kind, language)),
              ),
              row(
                forumActions.map((kind) => this.statusButton(a, c, kind, language)),
              ),
            ],
      ),
    );
  }
  private modal(id: string, title: string, language: UserLanguage, create = false) {
    const fields = create
      ? [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "title",
                label: text(language, "標題", "标题", "Title"),
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
          label: create
            ? text(language, "內容（含選填連結）", "内容（含可选链接）", "Details / reason")
            : text(language, "內容或處理理由", "内容或处理理由", "Details / reason"),
          style: 2,
          min_length: 1,
          max_length: 1400,
          required: true,
          ...(create
            ? {
                placeholder: text(
                  language,
                  "結案後保存 90 天；維運者可接觸資料，勿填不必要的個資。",
                  "结案后保存 90 天；运维人员可以接触数据，请勿填写不必要的个人信息。",
                  "Retained 90 days after closure; operators can access data. Avoid unnecessary personal data.",
                ),
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
    const language = userLanguage(i.locale),
      cases = this.store.list(a, offset);
    const rows = cases.map((c) =>
      row([
        button(
          `${stateName(caseStatus(c), language)} · ${c.title}`.slice(0, 80),
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
        button(text(language, "上一頁", "上一页", "Previous"), prefix + Math.max(0, offset - 4)),
      );
    if (cases.length > 4)
      nav.push(button(text(language, "下一頁", "下一页", "Next"), prefix + (offset + 4)));
    if (nav.length) rows.splice(4, rows.length - 4, row(nav));
    else rows.splice(4);
    await this.send(
      i,
      this.payload(
        page.length
          ? text(language, "選擇案件查看進度與回覆。", "选择案件查看进度与回复。", "Select a case to view updates.")
          : text(language, "尚無回報。", "还没有反馈。", "No reports yet."),
        rows,
      ),
    );
  }
  private async detail(i: any, a: Actor, c: CaseView, page?: number) {
    const language = userLanguage(i.locale);
    const index = Math.max(
      0,
      Math.min(page ?? c.events.length - 1, c.events.length - 1),
    );
    const event = c.events[index]!;
    let content = `**HK-${c.id.slice(0, 8)} · ${clean(c.title)}**\n${categoryName(c.category, language)} · ${this.statusName(c, language)} · ${c.mode === "anonymous" ? text(language, "匿名", "匿名", "Anonymous") : text(language, "私密", "私密", "Identified")}${c.sync === "pending" ? text(language, " · 論壇同步待處理", " · 论坛同步待处理", " · Forum sync pending") : ""}\n\n**${eventName(event.kind, language)} (${index + 1}/${c.events.length})**\n${clean(event.body)}`;
    if (c.privatePending)
      content +=
        "\n" +
        text(
          language,
          "私人討論串準備中，請稍後更新進度；你仍可在這裡補充內容。",
          "私人讨论串正在准备，请稍后更新进度；你仍然可以在这里补充内容。",
          "Your private conversation is being prepared. Refresh shortly, or add details here.",
        );
    if (c.request)
      content +=
        "\n\n" +
        text(language, "成員申請待社管決定。", "成员申请正等待社管决定。", "Member request awaiting a decision.");
    const nav = [];
    if (index > 0)
      nav.push(
        button(
          text(language, "較早紀錄", "较早记录", "Earlier"),
          this.code(a, c, (a.staff ? "staff_page:" : "page:") + (index - 1)),
        ),
      );
    if (index < c.events.length - 1)
      nav.push(
        button(
          text(language, "較新紀錄", "较新记录", "Newer"),
          this.code(a, c, (a.staff ? "staff_page:" : "page:") + (index + 1)),
        ),
      );
    const actions: any[] = [];
    const add = (
      traditional: string,
      simplified: string,
      english: string,
      kind: string,
      style = 2,
    ) =>
      actions.push(
        button(text(language, traditional, simplified, english), this.code(a, c, kind), style),
      );
    if (a.staff) {
      if (c.state === "closed") add("重開案件", "重开案件", "Reopen", "reopen");
      else {
        if (c.state === "submitted") add("認領", "认领", "Claim", "claim");
        add("回覆成員", "回复成员", "Reply", "reply", 1);
        add("要求補充", "要求补充", "Request details", "request_info");
      }
      if (c.request) add("拒絕申請", "拒绝申请", "Decline request", "reject");
    } else {
      if (c.state !== "closed") add("補充內容", "补充内容", "Add details", "supplement", 1);
      if (!c.request)
        add(
          c.state === "closed" ? "申請重開" : "申請結案",
          c.state === "closed" ? "申请重开" : "申请结案",
          c.state === "closed" ? "Request reopen" : "Request close",
          c.state === "closed" ? "request_reopen" : "request_close",
        );
    }
    const result: any = this.payload("", [
      row([
        button(
          text(language, "更新進度", "更新进度", "Refresh"),
          this.code(a, c, a.staff ? "staff_view" : "view"),
        ),
        ...(c.privateThreadId
          ? [
              {
                type: 2,
                style: 5,
                label: text(language, "開啟私人對話", "打开私人对话", "Open private conversation"),
                url: `https://discord.com/channels/${this.guildId}/${c.privateThreadId}`,
              },
            ]
          : []),
      ]),
      ...(nav.length ? [row(nav)] : []),
      ...(actions.length ? [row(actions)] : []),
      ...(a.staff
        ? [
            row([
              button(
                text(language, "貼文管理", "帖子管理", "Post management"),
                this.code(a, c, "staff_forum"),
              ),
            ]),
          ]
        : []),
    ]);
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
    const language = userLanguage(i.locale);
    let outcome: "success" | "failure" | "denied" = "success";
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
            id.split(":")[2] === "anonymous"
              ? text(language, "匿名回報", "匿名反馈", "Submit report")
              : text(language, "私密回報（顯示帳號）", "私密反馈（显示账号）", "Submit report"),
            language,
            true,
          ),
        );
        return true;
      }
      if (command && i.commandName === "hearthkeeper") {
        await this.send(i, this.menu(language));
        return true;
      }
      if ((command && i.commandName === "feedback") || id === "hk:new") {
        await this.send(i, this.menu(language));
        return true;
      }
      if (buttonInput && id.startsWith("hk:category:")) {
        const category = id.split(":")[2]!;
        if (!categories.some((c) => c.id === category))
          throw new CaseError("invalid");
        await this.send(i, this.consent(language, category));
        return true;
      }
      // For action buttons the role check must fit the initial modal response deadline.
      const opensAction = buttonInput && id.startsWith("hk:act:");
      if (!opensAction) {
        // A modal can outlive the thread's open state. Update only its already
        // private source panel; creating a new reply in an archived thread fails.
        // Public source messages must never receive private case results.
        if (modal && i.isFromMessage?.() && i.message?.flags?.has(MessageFlags.Ephemeral))
          await i.deferUpdate();
        else await i.deferReply({ flags: MessageFlags.Ephemeral });
      }
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
            ...(id.split(":")[2] === "identified" && this.privateParentId
              ? { privateParentId: this.privateParentId }
              : {}),
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
          this.modal(
            "hk:submit:" + code,
            eventName(action.action, language),
            language,
          ),
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
      outcome = code === "denied" ? "denied" : "failure";
      const messages: Record<string, [string, string, string]> = {
        denied: [
          "你沒有這個案件的操作權限。",
          "你没有这个案件的操作权限。",
          "You do not have access to this case.",
        ],
        stale: [
          "案件已有更新，請重新開啟案件後再送出。",
          "案件已有更新，请重新打开案件后再提交。",
          "The case changed. Reopen it before submitting.",
        ],
        expired: [
          "這個操作已過期，請從選單重新開啟案件。",
          "这个操作已过期，请从菜单重新打开案件。",
          "This action expired. Open the case again.",
        ],
        closed: [
          "案件已結案，請從「我的回報」申請重開。",
          "案件已结案，请从“我的反馈”申请重开。",
          "This case is closed. Request reopening from My reports.",
        ],
        reply_cooldown: [
          "補充內容間隔需滿 5 秒，請稍後再送出。",
          "补充内容需要间隔 5 秒，请稍后再提交。",
          "Wait 5 seconds between updates.",
        ],
        cooldown: [
          "回報間隔需滿 60 秒，請稍後再送出。",
          "反馈需要间隔 60 秒，请稍后再提交。",
          "Wait 60 seconds between reports.",
        ],
        limit: [
          "你已有 3 個未結案回報，請先在既有案件補充。",
          "你已有 3 个未结案反馈，请先在现有案件中补充。",
          "You already have 3 open reports. Add details to an existing case.",
        ],
        pending: [
          "社管正在處理上一個申請，請等候結果。",
          "社管正在处理上一个申请，请等待结果。",
          "Your previous request is awaiting a decision.",
        ],
        invalid: [
          "內容未符合表單要求，請檢查後再送出。",
          "内容不符合表单要求，请检查后再提交。",
          "Check the form requirements and submit again.",
        ],
      };
      const message = messages[code] ?? [
        "這次未能完成操作，請從「我的回報」確認是否已收到。",
        "这次没能完成操作，请从“我的反馈”确认是否已收到。",
        "The operation could not complete. Check My reports before retrying.",
      ];
      let content = text(language, ...message);
      if (modal) {
        const draft = i.fields.getTextInputValue("body");
        content +=
          "\n\n" +
          text(
            language,
            "本次填寫內容（可複製後重送）：",
            "本次填写内容（可复制后重新提交）：",
            "Your draft (copy before retrying):",
          ) +
          "\n" +
          draft.slice(0, 1400);
      }
      try {
        await this.send(i, this.payload(content));
      } catch {
        /* Never log private interaction payloads. */
      }
      return true;
    } finally {
      this.observe(modal ? "modal" : buttonInput ? "button" : "command", outcome);
    }
  }
}

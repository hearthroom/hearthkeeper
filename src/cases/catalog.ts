export const categories = [
  { id: "bug", zh: "功能異常", en: "Bug report" },
  { id: "billing", zh: "儲值問題", en: "Credit top-up" },
  { id: "account", zh: "帳號問題", en: "Account help" },
  { id: "card_error", zh: "角色卡錯誤", en: "Card error" },
  { id: "review", zh: "審核疑問", en: "Review question" },
  { id: "card_report", zh: "角色卡檢舉", en: "Report a card" },
] as const;
export const forumActions = ["archive", "lock", "archive_lock", "restore"];
export function categoryName(id: string, zh = true) {
  const c = categories.find((c) => c.id === id);
  return c ? (zh ? c.zh : c.en) : zh ? "一般回報" : "General feedback";
}
export function workflowKind(category: string) {
  return ["review", "card_report"].includes(category) ? "feedback" : "problem";
}
export const statusActions = [
  "set_waiting",
  "set_processing",
  "wait_technical",
  "discuss",
];
export const decisionActions = ["pass", "not_adopted"];
export const internalActions = [
  ...forumActions,
  ...statusActions,
  "thread_state",
];
export const statusLabels: Record<string, string> = {
  submitted: "等待中",
  in_progress: "處理中",
  waiting_technical: "等待中（技術）",
  under_discussion: "討論中",
  paused: "暫停處理",
  passed: "PASS",
  not_adopted: "未採納",
  waiting_member: "待補充",
  closed: "已結案",
};
export const statusEmojiNames: Record<string, string> = {
  submitted: "Waiting",
  in_progress: "Processing",
  waiting_technical: "Waiting_engineer",
  under_discussion: "under_discussion",
  paused: "In_Progress",
  passed: "Passed",
  not_adopted: "Not_adopted",
};
export const actionStatus: Record<string, string> = {
  set_waiting: "submitted",
  set_processing: "in_progress",
  wait_technical: "waiting_technical",
  discuss: "under_discussion",
  pass: "passed",
  not_adopted: "not_adopted",
  archive_lock: "paused",
  lock: "paused",
};
export type StatusCase = {
  category: string;
  state: string;
  resolution?: string | null;
  locked?: boolean;
  archived?: boolean;
};
export function caseStatus(c: StatusCase) {
  if (c.state === "closed") return c.resolution ?? "closed";
  if (c.locked && (workflowKind(c.category) === "feedback" || c.archived))
    return "paused";
  return c.state;
}
export function statusTag(state: string) {
  return statusLabels[state] ?? statusLabels.submitted!;
}
export function caseTagNames(
  category: string,
  state: string,
  flags: Omit<StatusCase, "category" | "state"> = {},
) {
  return [
    ...(category === "general" ? [] : [categoryName(category)]),
    statusTag(caseStatus({ category, state, ...flags })),
  ];
}
export function actionsFor(c: StatusCase) {
  if (c.state === "closed") return [];
  return [
    "set_waiting",
    "set_processing",
    ...(workflowKind(c.category) === "feedback"
      ? ["discuss", "pass", "not_adopted"]
      : ["wait_technical", "pass"]),
  ];
}

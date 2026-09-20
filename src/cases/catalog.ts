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
export const statusActions = [
  "set_waiting",
  "set_processing",
  "wait_technical",
];
export const internalActions = [...forumActions, ...statusActions];
export const statusLabels: Record<string, string> = {
  submitted: "🔵 等待中",
  in_progress: "⚪ 處理中",
  waiting_technical: "🟠 等待中（技術）",
  waiting_member: "待補充",
  closed: "已結案",
};
export function statusTag(state: string) {
  return statusLabels[state] ?? statusLabels.submitted!;
}
export function caseTagNames(category: string, state: string) {
  return [
    ...(category === "general" ? [] : [categoryName(category)]),
    statusTag(state),
  ];
}

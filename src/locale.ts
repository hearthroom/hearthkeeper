export type UserLanguage = "en" | "zh-Hans" | "zh-Hant";

export function userLanguage(locale?: string): UserLanguage {
  const normalized = locale?.toLowerCase();
  if (normalized === "zh-tw" || normalized === "zh-hk") return "zh-Hant";
  return normalized?.startsWith("zh-") ? "zh-Hans" : "en";
}

export function localize(
  language: UserLanguage,
  traditional: string,
  simplified: string,
  english: string,
) {
  return language === "zh-Hant"
    ? traditional
    : language === "zh-Hans"
      ? simplified
      : english;
}

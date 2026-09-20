import type { CommunityConfig } from "./community/bot.js";
import { isAbsolute } from "node:path";
import type { CaseConfig } from "./cases/discord.js";
export interface Config {
  cases?: CaseConfig;
  community?: CommunityConfig;
  token: string;
  applicationId: string;
  guildId: string;
  metricsHost: "127.0.0.1";
  metricsPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  function required(key: string): string {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  }
  function snowflake(key: string): string {
    const value = required(key);
    if (!/^\d{17,20}$/.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  }
  const token = required("DISCORD_TOKEN");
  const applicationId = snowflake("DISCORD_APPLICATION_ID");
  const guildId = snowflake("DISCORD_GUILD_ID");
  const rawPort = env.METRICS_PORT ?? "11940";
  if (!/^\d+$/.test(rawPort)) throw new Error("Invalid METRICS_PORT");
  const metricsPort = Number(rawPort);
  if (
    !Number.isInteger(metricsPort) ||
    metricsPort < 1024 ||
    metricsPort > 65535
  ) {
    throw new Error("Invalid METRICS_PORT");
  }
  let cases: CaseConfig | undefined;
  if (Object.keys(env).some((k) => k.startsWith("CASE_") && env[k])) {
    const forumId = snowflake("CASE_FORUM_ID");
    const staffRoleIds = required("CASE_STAFF_ROLE_IDS")
      .split(",")
      .map((s) => s.trim());
    if (
      !staffRoleIds.length ||
      staffRoleIds.some((id) => !/^\d{17,20}$/.test(id) || id === guildId)
    )
      throw new Error("Invalid CASE_STAFF_ROLE_IDS");
    const key = required("CASE_IDENTITY_KEY"),
      lookupKey = required("CASE_LOOKUP_KEY");
    if (
      !/^[a-f0-9]{64}$/i.test(key) ||
      !/^[a-f0-9]{64}$/i.test(lookupKey) ||
      key === lookupKey
    )
      throw new Error("Invalid case keys");
    const databasePath = required("CASE_DATABASE_PATH");
    if (!isAbsolute(databasePath))
      throw new Error("Invalid CASE_DATABASE_PATH");
    const privateParentId = env.CASE_PRIVATE_PARENT_ID
      ? snowflake("CASE_PRIVATE_PARENT_ID")
      : undefined;
    if (privateParentId === forumId)
      throw new Error("Invalid CASE_PRIVATE_PARENT_ID");
    const rawCapacity = env.CASE_PRIVATE_MAX_ACTIVE ?? "100";
    if (
      !/^\d+$/.test(rawCapacity) ||
      Number(rawCapacity) < 1 ||
      Number(rawCapacity) > 500 ||
      (!privateParentId && env.CASE_PRIVATE_MAX_ACTIVE)
    )
      throw new Error("Invalid CASE_PRIVATE_MAX_ACTIVE");
    cases = {
      forumId,
      staffRoleIds,
      key,
      lookupKey,
      databasePath,
      privateParentId,
      privateMaxActive: Number(rawCapacity),
    };
  }
  let community: CommunityConfig | undefined;
  if (env.COMMUNITY_ENABLED === "true") {
    const site = new URL(required("COMMUNITY_SITE_URL"));
    if (
      site.protocol !== "https:" ||
      site.pathname !== "/" ||
      site.search ||
      site.hash ||
      site.username ||
      site.password
    )
      throw new Error("Invalid COMMUNITY_SITE_URL");
    const key = required("COMMUNITY_BRIDGE_KEY");
    if (
      !/^[a-f0-9]{64}$/i.test(key) ||
      key === cases?.key ||
      key === cases?.lookupKey
    )
      throw new Error("Invalid COMMUNITY_BRIDGE_KEY");
    const databasePath = required("COMMUNITY_DATABASE_PATH");
    if (!isAbsolute(databasePath) || databasePath === cases?.databasePath)
      throw new Error("Invalid COMMUNITY_DATABASE_PATH");
    const channels = (env.COMMUNITY_XP_CHANNELS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      channels.some(
        (v) =>
          !/^\d{17,20}$/.test(v) ||
          v === cases?.forumId ||
          v === cases?.privateParentId,
      )
    )
      throw new Error("Invalid COMMUNITY_XP_CHANNELS");
    const roles = JSON.parse(
      env.COMMUNITY_ROLES ?? "[]",
    ) as CommunityConfig["roles"];
    if (
      !Array.isArray(roles) ||
      roles.length > 25 ||
      new Set(roles.map((r) => r.id)).size !== roles.length ||
      roles.some(
        (r) =>
          !/^\d{17,20}$/.test(r.id) ||
          r.id === guildId ||
          cases?.staffRoleIds.includes(r.id) ||
          Object.keys(r).some(
            (k) => !["id", "level", "badge", "linked"].includes(k),
          ) ||
          Number(r.level !== undefined) +
            Number(r.badge !== undefined) +
            Number(r.linked !== undefined) !==
            1 ||
          (r.level !== undefined &&
            (!Number.isInteger(r.level) || r.level < 1 || r.level > 1000)) ||
          (r.badge !== undefined && r.badge !== "first_work") ||
          (r.linked !== undefined && r.linked !== true),
      )
    )
      throw new Error("Invalid COMMUNITY_ROLES");
    community = {
      site: site.origin,
      key,
      databasePath,
      channels,
      roles,
      reviewChannel: env.COMMUNITY_REVIEW_CHANNEL
        ? snowflake("COMMUNITY_REVIEW_CHANNEL")
        : undefined,
    };
  }
  return {
    community,
    token,
    applicationId,
    guildId,
    metricsHost: "127.0.0.1",
    metricsPort,
    cases,
  };
}

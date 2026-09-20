import { isAbsolute } from "node:path";
import type { CaseConfig } from "./cases/discord.js";
export interface Config {
  cases?: CaseConfig;
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
  return {
    token,
    applicationId,
    guildId,
    metricsHost: "127.0.0.1",
    metricsPort,
    cases,
  };
}

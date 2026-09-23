import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
const env = {
  DISCORD_TOKEN: "test",
  DISCORD_APPLICATION_ID: "100000000000000001",
  DISCORD_GUILD_ID: "100000000000000002",
  COMMUNITY_ENABLED: "true",
  COMMUNITY_SITE_URL: "https://community.example/",
  COMMUNITY_BRIDGE_KEY: "ab".repeat(32),
  COMMUNITY_DATABASE_PATH: "/tmp/community-roles-test.db",
};
const roles = (rules: unknown) => ({ ...env, COMMUNITY_ROLES: JSON.stringify(rules) });
test("badge rules accept any website badge key, so new milestones need no Bot release", () => {
  const rules = [
    { id: "100000000000000010", badge: "first_work" },
    { id: "100000000000000011", badge: "creator_featured" },
    { id: "100000000000000012", badge: "member_anniversary" },
  ];
  assert.deepEqual(loadConfig(roles(rules)).community?.roles, rules);
});
test("badge rules still reject keys the website could never emit", () => {
  for (const badge of ["", "Creator-Featured", "event summer", "x".repeat(61), 5, null])
    assert.throws(() => loadConfig(roles([{ id: "100000000000000011", badge }])), /Invalid COMMUNITY_ROLES/);
});

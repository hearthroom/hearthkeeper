import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
const env = {
  DISCORD_TOKEN: "test",
  DISCORD_APPLICATION_ID: "100000000000000001",
  DISCORD_GUILD_ID: "100000000000000002",
};
test("case feature is all-or-nothing and requires separate valid keys, explicit forum, roles and persistent path", () => {
  assert.equal(loadConfig(env).cases, undefined);
  assert.throws(() =>
    loadConfig({ ...env, CASE_FORUM_ID: "100000000000000003" }),
  );
  const good = {
    ...env,
    CASE_FORUM_ID: "100000000000000003",
    CASE_STAFF_ROLE_IDS: "100000000000000004",
    CASE_DATABASE_PATH: "/tmp/cases.db",
    CASE_IDENTITY_KEY: "11".repeat(32),
    CASE_LOOKUP_KEY: "22".repeat(32),
  };
  assert.equal(loadConfig(good).cases?.staffRoleIds.length, 1);
  assert.throws(() =>
    loadConfig({ ...good, CASE_LOOKUP_KEY: good.CASE_IDENTITY_KEY }),
  );
  assert.throws(() =>
    loadConfig({ ...good, CASE_DATABASE_PATH: "relative.db" }),
  );
});
import { commandsFor } from "../src/runtime.js";
test("unconfigured installs do not advertise report commands they cannot handle", () => {
  assert.deepEqual(
    commandsFor(loadConfig(env)).map((c) => c.name),
    ["hearthkeeper", "ping"],
  );
});

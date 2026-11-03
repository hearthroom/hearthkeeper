import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
const env = { DISCORD_TOKEN: "test", DISCORD_APPLICATION_ID: "100000000000000001", DISCORD_GUILD_ID: "100000000000000002",
  COMMUNITY_ENABLED: "true", COMMUNITY_SITE_URL: "https://example.test", COMMUNITY_BRIDGE_KEY: "33".repeat(32),
  COMMUNITY_DATABASE_PATH: "/var/lib/hearthkeeper/community.db" };
test("full-listen channels are explicit, validated configuration", () => {
  assert.deepEqual(loadConfig(env).community?.relayListenChannels, []);
  assert.deepEqual(loadConfig({ ...env, COMMUNITY_RELAY_LISTEN_CHANNELS: " 300000000000000001,300000000000000002 " }).community?.relayListenChannels,
    ["300000000000000001", "300000000000000002"]);
  for (const value of ["all", "123", "300000000000000001,", "300000000000000001,300000000000000001"])
    assert.throws(() => loadConfig({ ...env, COMMUNITY_RELAY_LISTEN_CHANNELS: value }), /COMMUNITY_RELAY_LISTEN_CHANNELS/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createRuntime, commandDefinitions, gatewayIntents } from '../src/runtime.js';
import { GatewayIntentBits, MessageFlags } from 'discord.js';
import { createHealthServer } from '../src/health.js';

const env = {
  DISCORD_TOKEN: 'synthetic-test-token',
  DISCORD_APPLICATION_ID: '100000000000000001',
  DISCORD_GUILD_ID: '100000000000000002',
};

test('configuration requires explicit app, guild and token without exposing values', () => {
  for (const field of Object.keys(env)) {
    const input: Record<string,string> = {...env}; delete input[field];
    assert.throws(() => loadConfig(input), new RegExp(field));
  }
  assert.throws(() => loadConfig({...env, DISCORD_GUILD_ID:'sensitive-invalid-value'}), e =>
    e instanceof Error && !e.message.includes('sensitive-invalid-value'));
  assert.throws(() => loadConfig({...env, METRICS_PORT:'0'}));
  assert.throws(() => loadConfig({...env, METRICS_PORT:'65536'}));
  assert.equal(loadConfig(env).metricsHost, '127.0.0.1');
});

test('bootstrap requests only Guilds intent and exposes no unfinished case or punishment actions', () => {
  assert.deepEqual(gatewayIntents, [GatewayIntentBits.Guilds]);
  assert.deepEqual(commandDefinitions.map(x => x.name), ['hearthkeeper','ping']);
  assert.ok(commandDefinitions.every(x => x.dm_permission === false));
});

function interaction(guildId=env.DISCORD_GUILD_ID, commandName='hearthkeeper', locale='zh-TW') {
  const replies: unknown[] = [];
  return {
    guildId, commandName, locale, replies,
    applicationId: env.DISCORD_APPLICATION_ID,
    isChatInputCommand: () => true,
    reply: async (payload: unknown) => { replies.push(payload); },
  };
}

test('menu is private, disables mentions and has only public guide links', async () => {
  const runtime=createRuntime(loadConfig(env)); const input=interaction();
  await runtime.handle(input);
  assert.equal(input.replies.length,1);
  const reply=input.replies[0] as any;
  assert.equal(reply.flags,MessageFlags.Ephemeral);
  assert.deepEqual(reply.allowedMentions,{parse:[]});
  assert.match(reply.content,/尚未開放/);
  assert.equal(reply.components[0].components.length,3);
  for(const button of reply.components[0].components) {
    assert.equal(button.style,5);
    assert.ok(button.url.startsWith('https://'));
    assert.equal(button.custom_id,undefined);
  }
});

test('unsupported locale falls back to English', async () => {
  const runtime=createRuntime(loadConfig(env)); const input=interaction(undefined,undefined,'ja');
  await runtime.handle(input);
  assert.match((input.replies[0] as any).content,/not available yet/);
});

test('foreign guild, DM and mismatched application are rejected before responding', async () => {
  const runtime=createRuntime(loadConfig(env));
  for(const patch of [{guildId:'100000000000000003'},{guildId:null},{applicationId:'100000000000000004'}]) {
    const input={...interaction(),...patch}; await runtime.handle(input);
    assert.equal(input.replies.length,0);
  }
});

test('unknown commands and noncommands do not produce a response', async () => {
  const runtime=createRuntime(loadConfig(env));
  for(const input of [interaction(undefined,'unsupported'), {...interaction(),isChatInputCommand:()=>false}]) {
    await runtime.handle(input); assert.equal(input.replies.length,0);
  }
});

test('reply failures are counted without leaking payloads into telemetry', async () => {
  const runtime=createRuntime(loadConfig(env));
  const input={...interaction(), reply: async () => {throw new Error('synthetic-private-payload');}};
  await runtime.handle(input);
  const metrics=await runtime.metrics();
  assert.match(metrics,/hearthkeeper_interactions_total\{action="menu",outcome="failure"\} 1/);
  assert.ok(!metrics.includes('synthetic-private-payload'));
  assert.ok(!metrics.includes(env.DISCORD_GUILD_ID));
});

test('readiness reflects live Discord connection, not only process existence', async () => {
  const runtime=createRuntime(loadConfig(env));
  assert.equal(runtime.health('/readyz').status,503);
  runtime.setReady(true);
  assert.equal(runtime.health('/readyz').status,200);
  runtime.setReady(false);
  assert.equal(runtime.health('/readyz').status,503);
  assert.equal(runtime.health('/healthz').status,200);
  assert.equal(runtime.health('/unknown').status,404);
  const input=interaction(undefined,'ping'); await runtime.handle(input);
  assert.match((input.replies[0] as any).content,/爐邊管家/);
  assert.match(await runtime.metrics(),/action="ping",outcome="success"/);
});

test('systemd confines secrets and privileges and uses a dedicated account', () => {
  const unit=readFileSync(new URL('../deploy/hearthkeeper.service',import.meta.url),'utf8');
  for(const required of ['User=hearthkeeper','NoNewPrivileges=true','ProtectSystem=strict',
    'ProtectHome=true','PrivateTmp=true','EnvironmentFile=/etc/hearthkeeper/runtime.env',
    'Restart=on-failure','UMask=0077']) assert.ok(unit.includes(required),required);
  assert.ok(!unit.includes('DISCORD_TOKEN='));
});

test('real HTTP server returns readiness and metrics without public binding', async () => {
  const runtime=createRuntime(loadConfig(env));
  const server=createHealthServer(runtime);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();
    assert.ok(address && typeof address!=='string');
    assert.equal(address.address,'127.0.0.1');
    const base=`http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base+'/readyz')).status,503);
    runtime.setReady(true);
    assert.equal((await fetch(base+'/readyz')).status,200);
    assert.equal((await fetch(base+'/healthz')).status,200);
    assert.equal((await fetch(base+'/unknown')).status,404);
    assert.equal((await fetch(base+'/healthz',{method:'POST'})).status,405);
    const metrics=await fetch(base+'/metrics');
    assert.match(await metrics.text(),/hearthkeeper_gateway_ready 1/);
    assert.equal(metrics.headers.get('cache-control'),'no-store');
  } finally {await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});

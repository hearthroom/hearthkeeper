import { Client, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { createRuntime, gatewayIntents } from './runtime.js';
import { createHealthServer } from './health.js';

async function start() {
  const config=loadConfig(process.env);
  const runtime=createRuntime(config);
  const client=new Client({intents:gatewayIntents,allowedMentions:{parse:[]}});
  const status=(event:string)=>console.log(JSON.stringify({event}));
  const updateReady=()=>runtime.setReady(client.isReady() && Boolean(client.guilds.cache.get(config.guildId)?.available));

  client.on(Events.ClientReady,()=>{updateReady();status('gateway_connected');});
  client.on(Events.ShardDisconnect,()=>{runtime.setReady(false);status('gateway_disconnected');});
  client.on(Events.ShardReconnecting,()=>runtime.setReady(false));
  client.on(Events.ShardResume,updateReady);
  client.on(Events.GuildCreate,updateReady);
  client.on(Events.GuildDelete,updateReady);
  client.on(Events.GuildUnavailable,updateReady);
  client.on(Events.Error,()=>status('discord_error'));
  client.on(Events.ShardError,()=>status('gateway_error'));
  client.on(Events.InteractionCreate,async interaction=>{
    if(interaction.isChatInputCommand()) await runtime.handle(interaction);
  });

  const server=createHealthServer(runtime);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);server.listen(config.metricsPort,config.metricsHost,resolve);
  });

  let stopping=false;
  const shutdown=async()=>{
    if(stopping) return;stopping=true;runtime.setReady(false);
    server.close();await client.destroy();status('stopped');
  };
  process.once('SIGTERM',()=>void shutdown());
  process.once('SIGINT',()=>void shutdown());
  try {await client.login(config.token);} catch {
    await shutdown();throw new Error('Discord login failed');
  }
}

start().catch(()=>{
  console.error(JSON.stringify({event:'startup_failed'}));process.exitCode=1;
});

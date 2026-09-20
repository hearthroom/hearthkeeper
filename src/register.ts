import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { commandDefinitions } from './runtime.js';

async function register() {
  const config=loadConfig(process.env);
  const rest=new REST({version:'10'}).setToken(config.token);
  // Registration affects only this application's commands in its configured guild.
  await rest.put(Routes.applicationGuildCommands(config.applicationId,config.guildId),{body:commandDefinitions});
  const saved=await rest.get(Routes.applicationGuildCommands(config.applicationId,config.guildId)) as {name:string}[];
  const expected=commandDefinitions.map(x=>x.name).sort();
  if(JSON.stringify(saved.map(x=>x.name).sort())!==JSON.stringify(expected)) throw new Error('Readback mismatch');
  console.log(JSON.stringify({event:'commands_verified',count:saved.length}));
}
register().catch(()=>{console.error(JSON.stringify({event:'command_registration_failed'}));process.exitCode=1;});

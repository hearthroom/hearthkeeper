import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityBot } from '../src/community/bot.js';
import type { Client } from 'discord.js';
test('review delivery creates one blind card notice then edits the same message',async()=>{
 let sent=0,edited=0;const payloads:any[]=[];const message={id:'323456789012345678',author:{id:'bot'},embeds:[],edit:async(p:any)=>{edited++;payloads.push(p);return message;}};
 const channel={id:'223456789012345678',type:0,guildId:'guild',guild:{roles:{everyone:{id:'guild'},fetch:async()=>new Map()},members:{fetchMe:async()=>({})}},permissionsFor:()=>({has:()=>false}),permissionOverwrites:{cache:new Map()},messages:{fetch:async(input:any)=>typeof input==='string'?message:new Map()},send:async(p:any)=>{sent++;payloads.push(p);return message;}};
 const client={user:{id:'bot'},channels:{fetch:async()=>channel}} as unknown as Client;
 const bot=new CommunityBot(client,'guild',{site:'https://hearthroom.club',key:'a'.repeat(64),databasePath:':memory:',channels:[],roles:[],reviewChannel:channel.id},[]);
 let messageId:string|null=null;
 bot.call=async<T>(op:string,b:Record<string,unknown>={})=>{
  if(op==='review-project-v2')return {id:'review:s1',kind:'main',lease:'lease',revision:1,messageId,updatedAt:1700000000000,projection:{title:'Rain @everyone **test**',status:'pending',kind:'first',adult:false,submittedAt:1700000000000,approvals:1,required:2,claimant:'Reviewer',expiresAt:1700002700000,path:'/review/s1'},digest:null} as T;
  if(op==='review-check-v2')return {valid:true} as T;
  if(op==='review-ack-v2'){messageId=String(b.messageId);return {accepted:true} as T;}
  throw new Error('unexpected');
 };
 try{await (bot as any).reviewDelivery('review:s1');await (bot as any).reviewDelivery('review:s1');assert.equal(sent,1);assert.equal(edited,1);assert.deepEqual(payloads[0].allowedMentions,{parse:[]});assert.match(JSON.stringify(payloads[0]),/1.*2/);assert.doesNotMatch(JSON.stringify(payloads[0]),/PRIVATE AUTHOR/);}finally{bot.store.close();}
});
import { createRuntime } from '../src/runtime.js';
import { renderReviewNotice, reviewLocales } from '../src/community/review-notice.js';
test('review delivery metrics expose low-cardinality outcomes and freshness',async()=>{
 const r=createRuntime({token:'fake',applicationId:'a',guildId:'g',metricsHost:'127.0.0.1',metricsPort:11940});
 (r as any).reviewMetrics.record('main','updated',3);(r as any).reviewMetrics.health(2,Date.now()-3000);
 const m=await r.metrics();assert.match(m,/hearthkeeper_review_delivery_total.*kind="main".*outcome="updated"/);assert.match(m,/hearthkeeper_review_pending_deliveries 2/);assert.match(m,/hearthkeeper_review_oldest_pending_age_seconds [3-9]/);
});
test('all five review locales redact adult titles and escape member-controlled mentions',()=>{
 for(const locale of reviewLocales){const j:any={id:'review:s1',kind:'main',revision:1,updatedAt:1700000000000,projection:{title:'SECRET ADULT TITLE',adult:true,status:'pending',kind:'first',approvals:0,required:2,submittedAt:1700000000000,claimant:'@everyone **admin**',expiresAt:1700002700000,path:'/review/s1'}};
 const body=JSON.stringify(renderReviewNotice(j,'https://hearthroom.club',locale));assert.ok(!body.includes('SECRET ADULT TITLE'));assert.ok(!body.includes('@everyone'));assert.match(body,/0／2/);}
});
import { CommunityStore } from '../src/community/core.js';
test('uncertain review sends retain an attempt marker for bounded history recovery',()=>{
 const s=new CommunityStore(':memory:');
 try { (s as any).beginReviewAttempt('review:s1','channel',1000);(s as any).beginReviewAttempt('review:s1','channel',2000);assert.equal((s as any).reviewAttempt('review:s1','channel'),1000); }finally{s.close();}
});
test('private review channels accept inherent administrator access but reject ordinary extra roles',async()=>{
 const roles=new Map<string,{id:string;permissions:{has:()=>boolean}}>([['admin',{id:'admin',permissions:{has:()=>true}}]]);
 const channel:any={type:0,guildId:'guild',guild:{id:'guild',roles:{everyone:{id:'guild'},fetch:async()=>roles}},permissionsFor:(r:any)=>({has:()=>r.id!=='guild'}),permissionOverwrites:{cache:new Map()}};
 const bot=new CommunityBot({user:{id:'bot'},channels:{fetch:async()=>channel}} as any,'guild',{site:'https://hearthroom.club',key:'a'.repeat(64),databasePath:':memory:',channels:[],roles:[],reviewChannel:'channel'},[]);
 try{assert.equal(await bot.reviewChannel(),channel);roles.set('ordinary',{id:'ordinary',permissions:{has:()=>false}});await assert.rejects(()=>bot.reviewChannel(),/review_channel_denied/);}finally{bot.store.close();}
});
test('review reminders explain the pending claim and how to release it',async()=>{
 let content='';const bot=new CommunityBot({users:{fetch:async()=>({createDM:async()=>({send:async(p:any)=>{content=p.content;return {id:'message'};}})})}} as any,'guild',{site:'https://hearthroom.club',key:'a'.repeat(64),databasePath:':memory:',channels:[],roles:[]},[]);
 bot.call=async<T>()=>({kind:'review_reminder',path:'/review/s1',discord_id:'reviewer'} as T);
 try{await bot.notification('reminder');assert.match(content,/30 分鐘/);assert.match(content,/放回/);assert.ok(content.includes('https://hearthroom.club/review'));}finally{bot.store.close();}
});
test('lost Discord send responses recover the existing notice from history',async()=>{
 let sent=0,edited=0,exists=false;
 const message:any={id:'323456789012345678',createdTimestamp:Date.now(),author:{id:'bot'},embeds:[{url:'https://hearthroom.club/review/s1'}],edit:async()=>{edited++;return message;}};
 const channel:any={id:'223456789012345678',type:0,guildId:'guild',guild:{id:'guild',roles:{everyone:{id:'guild'},fetch:async()=>new Map()}},permissionsFor:()=>({has:()=>false}),permissionOverwrites:{cache:new Map()},messages:{fetch:async()=>new Map(exists?[[message.id,message]]:[])},send:async()=>{sent++;exists=true;throw new Error('response lost');}};
 const bot=new CommunityBot({user:{id:'bot'},channels:{fetch:async()=>channel}} as any,'guild',{site:'https://hearthroom.club',key:'a'.repeat(64),databasePath:':memory:',channels:[],roles:[],reviewChannel:channel.id},[]);
 bot.call=async<T>(op:string)=> (op==='review-project-v2'?{id:'review:s1',kind:'main',lease:'lease',revision:1,messageId:null,updatedAt:Date.now(),projection:{title:'Fixture',status:'pending',kind:'first',adult:false,submittedAt:Date.now(),approvals:0,required:2,claimant:null,expiresAt:null,path:'/review/s1'},digest:null}:op==='review-check-v2'?{valid:true}:{accepted:true}) as T;
 try{await assert.rejects(()=>bot.reviewDelivery('review:s1'),/response lost/);assert.ok(bot.store.reviewAttempt('review:s1',channel.id));await bot.reviewDelivery('review:s1');assert.equal(sent,1);assert.equal(edited,1);assert.equal(bot.store.reviewAttempt('review:s1',channel.id),undefined);}finally{bot.store.close();}
});

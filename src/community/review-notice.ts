import { createHash } from 'node:crypto';
export const reviewLocales=['zh-Hant','zh-Hans','en','ja','ko'] as const;
export type ReviewLocale=typeof reviewLocales[number];
export interface ReviewProjection {title:string;status:string;kind:string;adult:boolean;submittedAt:number;approvals:number;required:number;claimant:string|null;expiresAt:number|null;path:string}
export interface ReviewJob {id:string;kind:'main'|'digest';changed?:boolean;lease:string;revision:number;messageId:string|null;updatedAt:number;projection:ReviewProjection|null;digest:{total:number;claimed:number;second:number;items:(ReviewProjection&{waitingSince:number;escalated:boolean})[]}|null}
const copy={
 'zh-Hant':{title:'待審作品',adult:'成人作品待審',first:'初審',re:'重審',progress:'審核進度',votes:'位審核員通過',claimed:'目前審核員',free:'目前無人認領',expires:'認領到期',submitted:'送審時間',next:'下一步',wait:'等待目前審核員提交結果',second:'還需要另一位審核員',claim:'等待審核員認領',approved:'審核通過',rejected:'審核退件',superseded:'本輪審核已失效',open:'前往審核',queue:'查看待審清單',updated:'狀態更新',digest:'待審作品每日摘要',total:'等待超過 24 小時',unclaimed:'尚未開始',claimedCount:'認領中',secondCount:'等待另一位',urgent:'需協調',remaining:'其餘作品請查看待審清單'},
 'zh-Hans':{title:'待审作品',adult:'成人作品待审',first:'初审',re:'复审',progress:'审核进度',votes:'位审核员通过',claimed:'当前审核员',free:'当前无人认领',expires:'认领到期',submitted:'提交时间',next:'下一步',wait:'等待当前审核员提交结果',second:'还需要另一位审核员',claim:'等待审核员认领',approved:'审核通过',rejected:'审核退回',superseded:'本轮审核已失效',open:'前往审核',queue:'查看待审列表',updated:'状态更新',digest:'待审作品每日摘要',total:'等待超过 24 小时',unclaimed:'尚未开始',claimedCount:'已认领',secondCount:'等待另一位',urgent:'需要协调',remaining:'其余作品请查看待审列表'},
 en:{title:'Awaiting review',adult:'Adult submission',first:'Initial review',re:'Re-review',progress:'Progress',votes:'reviewers approved',claimed:'Current reviewer',free:'Available to claim',expires:'Claim expires',submitted:'Submitted',next:'Next step',wait:'Waiting for the current reviewer',second:'Another reviewer needed',claim:'Waiting for a reviewer to claim',approved:'Approved',rejected:'Rejected',superseded:'This review is no longer active',open:'Open review',queue:'Review queue',updated:'Updated',digest:'Daily review queue digest',total:'Waiting over 24 hours',unclaimed:'Not started',claimedCount:'Claimed',secondCount:'Another reviewer needed',urgent:'Needs coordination',remaining:'See the review queue for the remaining submissions'},
 ja:{title:'審査待ちの作品',adult:'成人向け作品の審査',first:'初回審査',re:'再審査',progress:'審査状況',votes:'名が承認済み',claimed:'現在の担当者',free:'担当者募集中',expires:'担当の有効期限',submitted:'提出日時',next:'次の手順',wait:'担当者の審査結果を待っています',second:'別の審査担当者が必要です',claim:'審査担当者を募集しています',approved:'承認済み',rejected:'差し戻し',superseded:'この審査は無効になりました',open:'審査を開く',queue:'審査一覧を見る',updated:'更新',digest:'審査待ち作品の日次まとめ',total:'24 時間以上待機中',unclaimed:'未着手',claimedCount:'担当中',secondCount:'別の担当者待ち',urgent:'調整が必要',remaining:'残りの作品は審査一覧で確認できます'},
 ko:{title:'검토 대기 작품',adult:'성인 작품 검토',first:'첫 검토',re:'재검토',progress:'검토 진행 상황',votes:'명 승인',claimed:'현재 담당자',free:'담당자 미정',expires:'담당 유효 시간',submitted:'제출 시간',next:'다음 단계',wait:'현재 담당자의 검토 결과를 기다리는 중',second:'다른 검토자가 필요합니다',claim:'검토 담당자를 기다리는 중',approved:'승인됨',rejected:'반려됨',superseded:'이 검토는 더 이상 유효하지 않습니다',open:'검토 열기',queue:'검토 목록 보기',updated:'업데이트',digest:'일일 검토 대기 요약',total:'24시간 이상 대기',unclaimed:'시작 전',claimedCount:'검토 중',secondCount:'다른 검토자 대기',urgent:'조율 필요',remaining:'나머지 작품은 검토 목록에서 확인하세요'},
};
export function safeReviewText(value:string,max=180){return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,max).replace(/([\\*_~`|>[\]()])/g,'\\$1').replace(/@/g,'＠');}
export function reviewNonce(id:string){return createHash('sha256').update('review-v2:'+id).digest('hex').slice(0,24);}
export function renderReviewNotice(job:ReviewJob,site:string,locale:ReviewLocale='zh-Hant'){
 const c=copy[locale],p=job.projection,d=job.digest;
 const timestamp=(n:number)=>`<t:${Math.floor(n/1000)}:f>`;
 const url=p?site+p.path:site+'/review?digest='+encodeURIComponent(job.id.slice(7));
 const title=p?(p.status==='pending'?c.title:(c[p.status as 'approved'|'rejected'|'superseded']??c.superseded)):c.digest;
 let description='';
 if(p){
  description=`**${p.adult?c.adult:safeReviewText(p.title)||c.title}**\n${p.kind==='first'?c.first:c.re}\n${c.progress}：${p.approvals}／${p.required} ${c.votes}\n`;
  if(p.status==='pending')description+=(p.claimant?`${c.claimed}：${safeReviewText(p.claimant,80)}\n${c.expires}：${timestamp(p.expiresAt!)}\n`:c.free+'\n')+`${c.next}：${p.claimant?c.wait:p.approvals>0?c.second:c.claim}\n`;
  description+=`${c.submitted}：${timestamp(p.submittedAt)}`;
 }else if(d){
  description=`${c.total}：**${d.total}**\n${c.unclaimed}：${d.total-d.claimed-d.second} · ${c.secondCount}：${d.second} · ${c.claimedCount}：${d.claimed}\n\n`;
  description+=d.items.map(i=>`${i.escalated?c.urgent+' · ':''}[${i.adult?c.adult:safeReviewText(i.title)||c.title}](${site+i.path}) · ${i.approvals}／${i.required}`).join('\n');
  if(d.total>d.items.length)description+='\n'+c.remaining;
 }
 return {allowedMentions:{parse:[] as never[]},embeds:[{title,url,description:description.slice(0,3900),color:p?.status==='approved'?0x57a773:0x8c7860,footer:{text:c.updated},timestamp:new Date(job.updatedAt).toISOString()}],components:[{type:1 as const,components:[...(p?.status==='pending'?[{type:2 as const,style:5 as const,label:c.open,url}]:[]),{type:2 as const,style:5 as const,label:c.queue,url:site+'/review'}]}]};
}

export function renderReviewReminder(site:string,locale:ReviewLocale='zh-Hant') {
 const text={
  'zh-Hant':'你認領的作品已超過 30 分鐘尚未完成審核。方便時請繼續審核；若暫時無法處理，可以放回待審清單，讓其他審核員接手。認領滿 45 分鐘時會到期。',
  'zh-Hans':'你认领的作品已超过 30 分钟尚未完成审核。方便时请继续审核；若暂时无法处理，可以放回待审列表，让其他审核员接手。认领满 45 分钟时会到期。',
  en:'Your claimed submission has been waiting for over 30 minutes. Please continue reviewing when you can, or release it so another reviewer can take over. Claims expire after 45 minutes.',
  ja:'担当してから 30 分以上、審査が完了していません。お時間のあるときに審査を続けるか、担当を解除して別の審査担当者に引き継いでください。担当は 45 分で期限切れになります。',
  ko:'담당한 작품의 검토가 30분 넘게 완료되지 않았습니다. 가능할 때 검토를 계속하거나 담당을 해제하여 다른 검토자에게 넘겨주세요. 담당 유효 시간은 45분입니다.',
 };
 return text[locale]+'\n<'+site+'/review>';
}

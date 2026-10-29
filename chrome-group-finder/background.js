const JOB_KEY = "gfpJob";
const RESULTS_KEY = "gfpResults";
async function getJob(){ return (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || null; }
async function setJob(job){ await chrome.storage.local.set({[JOB_KEY]:job}); }
async function setStatus(status, extra={}) { const job=await getJob(); if(job) await setJob({...job,status,...extra,updatedAt:Date.now()}); }
function makeSearchUrl(query,country,onlyUSA){const suffix=onlyUSA?"United States":((country&&country!=="Any country"&&country!=="Worldwide")?country:"");const clean=String(query||"").trim();const full=suffix?(clean?clean+", "+suffix:suffix):clean;return "https://www.facebook.com/search/groups/?q="+encodeURIComponent(full);}
async function openCurrent(job){
 if(job.phase!=="search")return;
 const query=job.queries[job.index];
 if(query!==undefined){
  let tabId=job.tabId;
  if(tabId){try{await chrome.tabs.get(tabId)}catch{tabId=null}}
  if(!tabId)tabId=(await chrome.tabs.create({url:"about:blank",active:true})).id;
  await setJob({...job,tabId,status:"searching",message:"Searching "+(job.index+1)+" of "+job.queries.length+": "+query,updatedAt:Date.now()});
  await chrome.tabs.update(tabId,{url:makeSearchUrl(query,job.country,job.onlyUSA),active:true});
  return;
 }
 await finish(job);
}
function scoreRow(row,job){const text=String((row.name||"")+" "+(row.snippet||"")).toLowerCase();const terms=[...(job.queries||[]),...String(job.extraKeywords||"").split(/[;,\n]+/)].map(x=>String(x).trim().toLowerCase()).filter(Boolean);const relevance=terms.length?Math.min(100,Math.round(terms.filter(t=>text.includes(t)).length/Math.min(terms.length,3)*100)):null;const members=Number.isFinite(row.members)?Math.min(100,Math.round(Math.log10(Math.max(1,row.members))/6*100)):null;const likes=row.visibleReactionCounts||[];const avgLikes=likes.length?Math.round(likes.reduce((a,b)=>a+b,0)/likes.length):null;const maxLikes=likes.length?Math.max(...likes):null;const likeScore=avgLikes!=null?Math.min(100,Math.round(Math.log10(avgLikes+1)/5*100)):null;const comments=row.visibleCommentCounts||[];const avgComments=comments.length?Math.round(comments.reduce((a,b)=>a+b,0)/comments.length):null;const commentScore=avgComments!=null?Math.min(100,Math.round(Math.log10(avgComments+1)/4*100)):null;const engagement=likeScore!=null?(commentScore!=null?Math.round(likeScore*.75+commentScore*.25):likeScore):commentScore;const recency=row.recentEvidence?100:((row.recentTimeLabels||[]).length?60:null);const activity=(row.visiblePostSignals||0)>0?Math.min(100,row.visiblePostSignals*12):null;const parts=[{v:relevance,w:.25},{v:members,w:.15},{v:engagement,w:.3},{v:recency,w:.2},{v:activity,w:.1}].filter(x=>x.v!=null);const score=parts.length?Math.round(parts.reduce((s,x)=>s+x.v*x.w,0)):null;return {...row,score,scoreEvidence:parts.length,averageVisibleLikes:avgLikes,maxVisibleLikes:maxLikes,averageVisibleComments:avgComments,rankingEvidence:{relevance,members,engagement,recency,visibleActivity:activity}};}
function rankRows(rows,job){const out=rows.map(r=>scoreRow(r,job));const selected=job.activityPriorities||[];out.sort((a,b)=>{const ap=Number.isFinite(a.postsPerDay)?a.postsPerDay:-1,bp=Number.isFinite(b.postsPerDay)?b.postsPerDay:-1;if(ap!==bp)return bp-ap;if(a.isPublic!==b.isPublic){if(a.isPublic===true)return -1;if(b.isPublic===true)return 1;}for(const mode of selected){let av=null,bv=null;if(mode==="most likes"){av=a.averageVisibleLikes;bv=b.averageVisibleLikes;}else if(mode==="largest communities"){av=a.members;bv=b.members;}else if(mode==="recent posts"){av=a.recentEvidence?2:((a.recentTimeLabels||[]).length?1:0);bv=b.recentEvidence?2:((b.recentTimeLabels||[]).length?1:0);}else if(mode==="very high"||mode==="high"){av=a.visiblePostSignals||0;bv=b.visiblePostSignals||0;}if(av!=null||bv!=null){av=av??-1;bv=bv??-1;if(av!==bv)return bv-av;}}const as=Number.isFinite(a.score)?a.score:-1,bs=Number.isFinite(b.score)?b.score:-1;if(as!==bs)return bs-as;return (b.members??-1)-(a.members??-1);});return out;}
async function finish(job){
 const collected=(await chrome.storage.local.get(RESULTS_KEY))[RESULTS_KEY]||[];
 // Rank by the strongest evidence actually visible on search cards. Do not discard
 // candidates merely because Facebook hides a public label, member count, or posts/day.
 // Those fields stay "not shown" in the UI instead of being invented.
 const ranked=rankRows(collected,job).slice(0,50);
 await chrome.storage.local.set({[RESULTS_KEY]:ranked});
 const scored=ranked.filter(r=>r.score!=null).length;
 await setStatus("complete",{phase:"complete",message:"Search complete. Showing the top "+ranked.length+" unique group candidates (maximum 50), ranked by visible relevance, member-size, engagement, and recency signals. Higher evidence scores appear first; hidden Public/member/posts-per-day details are not guessed. No group pages were opened."});
}
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{(async()=>{
 if(msg.type==="START_SCAN"){const active=await getJob();if(active&&["starting","searching","checking-details"].includes(active.status)){sendResponse({ok:false,error:"A search is already running. Stop it or wait for it to finish before starting another."});return;}const queries=String(msg.keywords||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);if(!queries.length)queries.push("");const job={queries,country:msg.country||"Any country",onlyUSA:Boolean(msg.onlyUSA),minimumMembers:Number(msg.minimumMembers)||0,minimumScore:Number(msg.minimumScore)||0,activityPriorities:Array.isArray(msg.activityPriorities)?msg.activityPriorities:[],extraKeywords:String(msg.extraKeywords||""),phase:"search",index:0,tabId:null,status:"starting",message:"Starting Chrome search",startedAt:Date.now()};await chrome.storage.local.set({[RESULTS_KEY]:[]});await setJob(job);await openCurrent(job);sendResponse({ok:true,count:queries.length});return;}
 if(msg.type==="PAGE_RESULTS"){const job=await getJob();if(!job||job.phase!=="search"||job.status!=="searching"||sender.tab?.id!==job.tabId){sendResponse({ok:false});return;}if(msg.blocked){await setStatus("paused",{message:"Facebook login, checkpoint, CAPTCHA, or restricted page detected. Complete any normal check yourself, then restart."});sendResponse({ok:true,paused:true});return;}const incoming=Array.isArray(msg.results)?msg.results:[];const old=(await chrome.storage.local.get(RESULTS_KEY))[RESULTS_KEY]||[];const byUrl=new Map(old.map(x=>[x.url,x]));for(const item of incoming){if(!item?.url||!item?.name)continue;const prior=byUrl.get(item.url);byUrl.set(item.url,{...prior,...item,keywords:[...new Set([...(prior?.keywords||[]),job.queries[job.index]])]});}await chrome.storage.local.set({[RESULTS_KEY]:[...byUrl.values()]});const next={...job,index:job.index+1};await setJob(next);await openCurrent(next);sendResponse({ok:true,added:incoming.length});return;}

 if(msg.type==="STOP_SCAN"){await setStatus("stopped",{message:"Search stopped by user. Current tab remains open."});sendResponse({ok:true});return;}
 if(msg.type==="GET_STATE"){const d=await chrome.storage.local.get([JOB_KEY,RESULTS_KEY]);sendResponse({job:d[JOB_KEY]||null,results:d[RESULTS_KEY]||[]});return;}
 if(msg.type==="CLEAR_RESULTS"){await chrome.storage.local.set({[RESULTS_KEY]:[]});sendResponse({ok:true});return;}
 if(msg.type==="EXPORT_RESULTS"){const d=await chrome.storage.local.get(RESULTS_KEY);sendResponse({results:d[RESULTS_KEY]||[]});return;}
})().catch(err=>sendResponse({ok:false,error:String(err)}));return true;});
chrome.tabs.onRemoved.addListener(async tabId=>{const job=await getJob();if(job?.tabId===tabId&&["searching","checking-details"].includes(job.status))await setStatus("stopped",{message:"Search tab was closed."});});
const JOB_KEY = "gfpJob";
const RESULTS_KEY = "gfpResults";

async function getJob(){ return (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || null; }
async function setJob(job){ await chrome.storage.local.set({[JOB_KEY]:job}); }
async function setStatus(status, extra={}) {
  const job = await getJob();
  if (!job) return;
  await setJob({...job,status,...extra,updatedAt:Date.now()});
}
function makeSearchUrl(query, country, onlyUSA) {
  const terms = [query];
  if (onlyUSA) terms.push("United States");
  else if (country && country !== "Any country") terms.push(country);
  return "https://www.facebook.com/search/groups/?q=" + encodeURIComponent(terms.join(" "));
}
async function openCurrent(job) {
  const query = job.queries[job.index];
  if (!query) {
    const saved=(await chrome.storage.local.get(RESULTS_KEY))[RESULTS_KEY]||[];
    await setStatus("complete", {message:`Search complete. Collected ${saved.length} unique visible group results.`});
    return;
  }
  const message = `Searching ${job.index+1} of ${job.queries.length}: ${query}`;
  let tabId = job.tabId;
  if (tabId) { try { await chrome.tabs.get(tabId); } catch { tabId = null; } }
  if (!tabId) { const tab = await chrome.tabs.create({url:"about:blank", active:true}); tabId = tab.id; }
  // Save the tab id before navigation to prevent the first content-script message racing the job state.
  await setJob({...job,tabId,status:"searching",message,updatedAt:Date.now()});
  await chrome.tabs.update(tabId,{url:makeSearchUrl(query,job.country,job.onlyUSA),active:true});
}
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  (async()=>{
    if(msg.type==="START_SCAN"){
      const queries=String(msg.keywords||"").split(/[\n,;]+/).map(s=>s.trim()).filter(Boolean);
      if(!queries.length){sendResponse({ok:false,error:"Enter at least one keyword."});return;}
      const job={queries,country:msg.country||"Any country",onlyUSA:Boolean(msg.onlyUSA),index:0,tabId:null,status:"starting",message:"Starting Chrome search",startedAt:Date.now()};
      await chrome.storage.local.set({[RESULTS_KEY]:[]});
      await setJob(job); await openCurrent(job); sendResponse({ok:true,count:queries.length}); return;
    }
    if(msg.type==="PAGE_RESULTS"){
      const job=await getJob();
      if(!job || job.status!=="searching" || sender.tab?.id!==job.tabId){sendResponse({ok:false});return;}
      if(msg.blocked){
        await setStatus("paused",{message:"Facebook login, checkpoint, CAPTCHA, or a restricted page was detected. Complete any normal Facebook check yourself, then start a new search."});
        sendResponse({ok:true,paused:true});return;
      }
      const incoming=Array.isArray(msg.results)?msg.results:[];
      const old=(await chrome.storage.local.get(RESULTS_KEY))[RESULTS_KEY]||[];
      const byUrl=new Map(old.map(x=>[x.url,x]));
      for(const item of incoming){
        if(!item?.url||!item?.name)continue;
        const prior=byUrl.get(item.url);
        byUrl.set(item.url,{...prior,...item,keywords:[...new Set([...(prior?.keywords||[]),job.queries[job.index]])]});
      }
      await chrome.storage.local.set({[RESULTS_KEY]:[...byUrl.values()]});
      const next={...job,index:job.index+1};
      await setJob(next); await openCurrent(next); sendResponse({ok:true,added:incoming.length});return;
    }
    if(msg.type==="STOP_SCAN"){
      await setStatus("stopped",{message:"Search stopped by user. The search tab remains open."});
      sendResponse({ok:true});return;
    }
    if(msg.type==="GET_STATE"){
      const data=await chrome.storage.local.get([JOB_KEY,RESULTS_KEY]);
      sendResponse({job:data[JOB_KEY]||null,results:data[RESULTS_KEY]||[]});return;
    }
    if(msg.type==="CLEAR_RESULTS"){await chrome.storage.local.set({[RESULTS_KEY]:[]});sendResponse({ok:true});return;}
    if(msg.type==="EXPORT_RESULTS"){const data=await chrome.storage.local.get(RESULTS_KEY);sendResponse({results:data[RESULTS_KEY]||[]});return;}
  })().catch(err=>sendResponse({ok:false,error:String(err)}));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId=>{
  const job=await getJob();
  if(job?.tabId===tabId&&job.status==="searching")await setStatus("stopped",{message:"Search tab was closed."});
});

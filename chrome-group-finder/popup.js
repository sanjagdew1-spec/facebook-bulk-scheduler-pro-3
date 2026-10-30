const $=id=>document.getElementById(id);
async function send(message){return await chrome.runtime.sendMessage(message)}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function render(state){
 const job=state.job,results=state.results||[];
 $("count").textContent=results.length;
 $("status").textContent=job?.message||(job?.status==="complete"?"Search complete.":job?.status==="paused"?"Paused by Facebook security check.":"Ready. Keep Facebook logged in in Chrome.");
 $("results").innerHTML=results.length?results.map(r=>`<article class="result"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a><p>${esc(r.url)}</p><p>${esc(r.snippet||"")}</p><p>Evidence score: ${esc(r.score==null?"Not enough evidence":r.score+"/100")} · Public: ${esc(r.isPublic===true?"visible":r.isPublic===false?"private shown":"not shown")} · Members: ${esc(r.members==null?"not shown":Number(r.members).toLocaleString())} · Posts/day: ${esc(r.postsPerDayLabel||(r.postsPerDay==null?"not shown":Number(r.postsPerDay).toLocaleString()+" posts/day"))} · Avg visible reactions: ${esc(r.averageVisibleLikes==null?"not shown":Number(r.averageVisibleLikes).toLocaleString())}</p><p class="keywords">Keyword: ${esc((r.keywords||[]).join(", "))}</p></article>`).join(""):'<p class="muted">No results collected yet. Start a search; only groups visible on Facebook will be listed.</p>';
}
async function refresh(){try{render(await send({type:"GET_STATE"}))}catch(e){$("status").textContent="Could not read extension state: "+e}}
$("start").addEventListener("click",async()=>{
 const keywords=$("keywords").value.trim();
 if(!keywords){$("status").textContent="Enter at least one keyword.";return}
 $("status").textContent="Starting search…";
 try{
  const r=await send({type:"START_SCAN",keywords,country:$("country").value,onlyUSA:$("onlyUSA").checked});
  if(!r?.ok)$("status").textContent=r?.error||"Could not start search.";
  await refresh();
 }catch(e){$("status").textContent="Could not start search: "+e}
});
$("stop").addEventListener("click",async()=>{await send({type:"STOP_SCAN"});await refresh()});
$("clear").addEventListener("click",async()=>{await send({type:"CLEAR_RESULTS"});await refresh()});
$("export").addEventListener("click",async()=>{
 const r=await send({type:"EXPORT_RESULTS"}),rows=r.results||[];
 const q=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
 const csv=["Group Name,URL,Keywords,Evidence Score,Public Status,Members,Posts Per Day,Average Visible Likes,Visible Reaction Counts,Visible Comment Counts,Recent Labels,Visible Snippet",...rows.map(x=>[x.name,x.url,(x.keywords||[]).join("; "),x.score,x.isPublic===true?"Public":x.isPublic===false?"Private":"Not shown",x.members,x.postsPerDay,x.averageVisibleLikes,(x.visibleReactionCounts||[]).join("; "),(x.visibleCommentCounts||[]).join("; "),(x.recentTimeLabels||[]).join("; "),x.snippet].map(q).join(","))].join("\r\n");
 const blob=new Blob([csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download="group-finder-results.csv";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
refresh();setInterval(refresh,1200);
async function enableVisualCaptureForActiveGroup(){
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!/^https:\/\/www\.facebook\.com\/groups\//i.test(tab.url||""))return;
  const screenshotDataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"jpeg",quality:42});
  const result=await send({type:"ENABLE_VISUAL_CAPTURE",tabId:tab.id,screenshotDataUrl});
  $("status").textContent=result?.ok
   ?"Visual screenshots enabled for this Facebook Group. Keep the Group tab active while Activity Lab scans."
   :(result?.error||"Could not enable visual screenshots for this tab.");
 }catch(error){
  $("status").textContent="Visual screenshot permission was not available: "+String(error);
 }
}
enableVisualCaptureForActiveGroup();
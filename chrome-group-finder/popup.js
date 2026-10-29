const $=id=>document.getElementById(id);
async function send(message){return await chrome.runtime.sendMessage(message)}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function render(state){
 const job=state.job,results=state.results||[];
 $("count").textContent=results.length;
 $("status").textContent=job?.message||(job?.status==="complete"?"Search complete.":job?.status==="paused"?"Paused by Facebook security check.":"Ready. Keep Facebook logged in in Chrome.");
 $("results").innerHTML=results.length?results.map(r=>`<article class="result"><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a><p>${esc(r.url)}</p><p>${esc(r.snippet||"")}</p><p class="keywords">Keyword: ${esc((r.keywords||[]).join(", "))}</p></article>`).join(""):'<p class="muted">No results collected yet. Start a search; only groups visible on Facebook will be listed.</p>';
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
 const csv=["Group Name,URL,Keywords,Visible Snippet",...rows.map(x=>[x.name,x.url,(x.keywords||[]).join("; "),x.snippet].map(q).join(","))].join("\r\n");
 const blob=new Blob([csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download="group-finder-results.csv";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
refresh();setInterval(refresh,1200);
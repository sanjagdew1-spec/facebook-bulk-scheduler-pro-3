(() => {
  if (window.__gfpScanStarted) return;
  window.__gfpScanStarted = true;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const excluded = new Set(["feed","create","discover","joins","notifications","your_groups","requests","pending","search","member_requests","about"]);
  function isVisible(el){
    if(!el) return false;
    const r=el.getBoundingClientRect();
    const s=getComputedStyle(el);
    return r.width>0 && r.height>0 && s.visibility!=="hidden" && s.display!=="none";
  }
  function cleanUrl(raw){
    try{
      const u=new URL(raw,location.origin);
      if(!/facebook\.com$/i.test(u.hostname) && !/\.facebook\.com$/i.test(u.hostname)) return null;
      const parts=u.pathname.split("/").filter(Boolean);
      if(parts[0]!=="groups" || !parts[1] || excluded.has(parts[1].toLowerCase())) return null;
      if(parts[1].startsWith("search")) return null;
      return "https://www.facebook.com/groups/"+parts[1]+"/";
    }catch{return null;}
  }
  function cardText(anchor){
    let node=anchor;
    for(let i=0;i<5 && node;i++,node=node.parentElement){
      const text=(node.innerText||"").trim();
      if(text.length>=12 && text.length<1800) return text;
    }
    return (anchor.innerText||anchor.getAttribute("aria-label")||"").trim();
  }
  async function scan(){
    await sleep(2800);
    if(location.pathname.startsWith("/login") || document.querySelector('input[name="email"]')){
      chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[]});
      return;
    }
    const found=new Map();
    for(const a of document.querySelectorAll('a[href*="/groups/"]')){
      if(!isVisible(a)) continue;
      const url=cleanUrl(a.href);
      if(!url) continue;
      const text=cardText(a);
      const anchorText=(a.innerText||a.getAttribute("aria-label")||"").trim();
      let name=anchorText;
      if(!name || name.length>180){
        name=(text.split("\n").map(x=>x.trim()).find(x=>x.length>2 && x.length<150 && !/^(public|private|group|join|see more|view more|posts?|members?)$/i.test(x))||"");
      }
      name=name.replace(/\s+/g," ").trim();
      if(!name || /^(facebook|see all|view all|join group|group)$/i.test(name)) continue;
      const existing=found.get(url);
      found.set(url,{name,url,snippet:text.slice(0,500),source:"Visible Facebook search result", ...(existing||{})});
    }
    chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[...found.values()]});
  }
  scan();
})();
(() => {
  const WEBSITE_ORIGIN = "https://top-facebook-group-finder-preview.onrender.com";
  if (location.origin === WEBSITE_ORIGIN) {
    if (window.__gfpWebsiteBridge) return;
    window.__gfpWebsiteBridge = true;
    const sendState = async () => {
      try {
        const state = await chrome.runtime.sendMessage({type:"GET_STATE"});
        window.postMessage({source:"gfp-chrome-helper",type:"STATE",state},WEBSITE_ORIGIN);
      } catch {}
    };
    window.addEventListener("message", async event => {
      if (event.source !== window || event.origin !== WEBSITE_ORIGIN) return;
      const msg = event.data;
      if (!msg || msg.source !== "top-facebook-group-finder") return;
      if (msg.type === "PING") {
        window.postMessage({source:"gfp-chrome-helper",type:"READY",available:true},WEBSITE_ORIGIN);
      } else if (msg.type === "START_SCAN") {
        const p = msg.payload || {};
        const keywords = Array.isArray(p.keywords) ? p.keywords.join("\n") : "";
        try {
          const response = await chrome.runtime.sendMessage({type:"START_SCAN",keywords,country:p.country||"Any country",onlyUSA:Boolean(p.onlyUSA)});
          if (!response?.ok) window.postMessage({source:"gfp-chrome-helper",type:"ERROR",error:response?.error||"Could not start Chrome search."},WEBSITE_ORIGIN);
          await sendState();
        } catch (error) {
          window.postMessage({source:"gfp-chrome-helper",type:"ERROR",error:String(error)},WEBSITE_ORIGIN);
        }
      }
    });
    sendState();
    setInterval(sendState,1000);
    return;
  }
  if (window.__gfpScanStarted) return;
  window.__gfpScanStarted = true;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const excluded = new Set(["feed","create","discover","joins","notifications","your_groups","requests","pending","search","member_requests","about"]);
  function visible(el){
    if(!el)return false;
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";
  }
  function groupUrl(raw){
    try{
      const u=new URL(raw,location.origin);
      if(!/(^|\.)facebook\.com$/i.test(u.hostname))return null;
      const p=u.pathname.split("/").filter(Boolean);
      if(p[0]!=="groups"||!p[1]||excluded.has(p[1].toLowerCase()))return null;
      return "https://www.facebook.com/groups/"+p[1]+"/";
    }catch{return null;}
  }
  function getCardText(anchor){
    let node=anchor;
    for(let i=0;i<6&&node;i++,node=node.parentElement){
      const t=(node.innerText||"").trim();
      if(t.length>=12&&t.length<1800)return t;
    }
    return (anchor.innerText||"").trim();
  }
  async function scan(){
    // Give Facebook's client-rendered search results time to load.
    await sleep(3500);
    const pageText=(document.body?.innerText||"").slice(0,12000).toLowerCase();
    const blocked=location.pathname.startsWith("/login") ||
      /checkpoint|confirm your identity|security check|enter the code|captcha/.test(location.pathname+" "+pageText) ||
      Boolean(document.querySelector('input[name="email"]'));
    if(blocked){chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[],blocked:true});return;}
    // A small, normal page scroll allows additional already-rendered result cards to appear.
    window.scrollBy({top:Math.min(window.innerHeight*0.7,500),behavior:"instant"});
    await sleep(900);
    const found=new Map();
    for(const a of document.querySelectorAll('a[href*="/groups/"]')){
      if(!visible(a))continue;
      const url=groupUrl(a.href);if(!url)continue;
      const text=getCardText(a);
      let name=(a.innerText||a.getAttribute("aria-label")||"").replace(/\s+/g," ").trim();
      if(!name||name.length>180){
        name=text.split("\n").map(x=>x.trim()).find(x=>x.length>2&&x.length<150&&!/^(public|private|group|join|see more|view more|posts?|members?)$/i.test(x))||"";
      }
      name=name.replace(/\s+/g," ").trim();
      if(!name||/^(facebook|see all|view all|join group|group)$/i.test(name))continue;
      const old=found.get(url);
      found.set(url,{name,url,snippet:text.slice(0,500),source:"Visible Facebook search result",...(old||{})});
    }
    chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[...found.values()],blocked:false});
  }
  scan().catch(()=>chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[],blocked:false}));
})();
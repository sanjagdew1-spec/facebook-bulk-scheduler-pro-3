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
          const response = await chrome.runtime.sendMessage({type:"START_SCAN",keywords,country:p.country||"Any country",onlyUSA:Boolean(p.onlyUSA),minimumMembers:Number(p.minimumMembers)||0,activityPriorities:Array.isArray(p.activityPriorities)?p.activityPriorities:[],minimumScore:Number(p.minimumScore)||0,extraKeywords:p.extraKeywords||""});
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
    // The group title link is often only a few words; Public, member count,
    // and activity sit in sibling elements in the same visible result card.
    const candidates=[];
    let node=anchor;
    for(let depth=0;depth<8&&node;depth++,node=node.parentElement){
      const t=(node.innerText||"").trim();
      if(t.length<12||t.length>900)continue;
      const signals=[
        /\bpublic(?:\s+group)?\b|\bprivate(?:\s+group)?\b/i.test(t),
        /[\d,.]+\s*[KMB]?\s+(?:members|people in this group|group members)\b/i.test(t),
        /[\d,.]+\s*[KMB]?\+?\s+(?:new\s+)?posts?\s+(?:a|per)\s+day\b/i.test(t),
        /[\d,.]+\s*[KMB]?\+?\s+posts?\s+(?:in|during)\s+(?:the\s+)?(?:last|past)\s+24\s+hours?\b/i.test(t),
        /\bjoin\b/i.test(t)
      ].filter(Boolean).length;
      candidates.push({text:t,signals,depth});
    }
    if(!candidates.length)return (anchor.innerText||"").trim();
    candidates.sort((x,y)=>y.signals-x.signals||x.text.length-y.text.length||x.depth-y.depth);
    return candidates[0].text;
  }
  async function scan(){
    // Give Facebook's client-rendered search results time to load.
    await sleep(3500);
    const pageText=(document.body?.innerText||"").slice(0,30000);
    const pageLow=pageText.toLowerCase();
    const blocked=location.pathname.startsWith("/login") ||
      /checkpoint|confirm your identity|security check|enter the code|captcha/.test(location.pathname+" "+pageLow) ||
      Boolean(document.querySelector('input[name="email"]'));
    if(blocked){chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[],blocked:true});return;}
    const isGroupPage=/^\/groups\/[^/]+\/?$/.test(location.pathname);
    function countValue(raw){const m=String(raw||"").replace(/,/g,"").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);if(!m)return null;return Math.round(Number(m[1])*({K:1e3,M:1e6,B:1e9}[(m[2]||"").toUpperCase()]||1));}
    function countryEvidence(text){
      const lines=String(text||"").split(/\n+/).map(s=>s.trim()).filter(Boolean);
      const countryNames={
        "United States":["united states","usa","u.s.a."],"Canada":["canada"],"India":["india"],"Brazil":["brazil","brasil"],
        "United Kingdom":["united kingdom","england","scotland","wales","northern ireland"],"Australia":["australia"],
        "Germany":["germany","deutschland"],"France":["france"],"Italy":["italy","italia"],"Mexico":["mexico","méxico"]
      };
      for(let i=0;i<lines.length;i++){
        const line=lines[i];
        if(!/\b(location|located|based in|country|headquarters|headquartered)\b/i.test(line))continue;
        const context=(line+" "+(lines[i+1]||"")).toLowerCase();
        for(const [country,names] of Object.entries(countryNames)){
          if(names.some(n=>context.includes(n)))return {country,countryEvidenceText:line.slice(0,180),countryEvidenceType:"explicit-location-text"};
        }
      }
      return {country:null,countryEvidenceText:null,countryEvidenceType:"unknown"};
    }
    function evidence(text){
      const member=text.match(/([\d,.]+\s*[KMB]?)\s+(?:members|people in this group|group members)\b/i);
      const reactions=[...text.matchAll(/([\d,.]+\s*[KMB]?)\s+(?:likes?|reactions?)\b/gi)].map(m=>countValue(m[1])).filter(Number.isFinite).slice(0,12);
      const comments=[...text.matchAll(/([\d,.]+\s*[KMB]?)\s+comments?\b/gi)].map(m=>countValue(m[1])).filter(Number.isFinite).slice(0,12);
      const times=[...text.matchAll(/\b(just now|\d+\s*(?:m|min|minutes?|h|hr|hours?|d|days?|w|weeks?|months?|years?)\s+ago|yesterday)\b/gi)].map(m=>m[0]);
      const dailyPosts=text.match(/(\d[\d,.]*\s*[KMB]?\+?)\s+(?:new\s+)?posts?\s+(?:a|per)\s+day\b/i)
        ||text.match(/(\d[\d,.]*\s*[KMB]?\+?)\s+posts?\s+(?:in|during)\s+(?:the\s+)?(?:last|past)\s+24\s+hours?\b/i);
      const isPublic=/\bpublic(?:\s+group)?\b/i.test(text);
      const isPrivate=/\bprivate(?:\s+group)?\b/i.test(text);
      return {isPublic:isPublic?true:(isPrivate?false:null),members:member?countValue(member[1]):null,postsPerDay:dailyPosts?countValue(dailyPosts[1]):null,postsPerDayLabel:dailyPosts?dailyPosts[1].replace(/\s+/g," ").trim()+" posts/day":null,visibleReactionCounts:reactions,visibleCommentCounts:comments,recentTimeLabels:[...new Set(times)].slice(0,12),recentEvidence:times.some(x=>/just now|\d+\s*(?:m|min|minutes?|h|hr|hours?)\s+ago|yesterday/i.test(x)),visiblePostSignals:Math.max(reactions.length,comments.length,times.length),...countryEvidence(text)};
    }
    if(isGroupPage){
      const parseMetric=(text,kind)=>{
        const patterns=kind==="shares"?[/([\\d,.]+\\s*[KMB]?)\\s+shares?\\b/i]:kind==="comments"?[/([\\d,.]+\\s*[KMB]?)\\s+comments?\\b/i]:[/([\\d,.]+\\s*[KMB]?)\\s+(?:likes?|reactions?)\\b/i];
        for(const re of patterns){const m=String(text||"").match(re);if(m)return countValue(m[1]);}
        return null;
      };
      const isRecent24h=text=>{
        const t=String(text||"").toLowerCase();
        if(/\\b(just now|\\d+\\s*(?:m|min|minutes?|h|hr|hours?)\\s+ago)\\b/.test(t)) {
          const m=t.match(/(\\d+)\\s*(?:h|hr|hours?)\\s+ago/);
          return !m||Number(m[1])<=24;
        }
        return /\\b(today|\\d+\\s*(?:m|min|minutes?)\\s+ago)\\b/.test(t);
      };
      const articles=[...document.querySelectorAll('[role="article"]')].filter(visible);
      const recentPosts=[];
      for(const article of articles){
        const text=(article.innerText||"").trim();
        if(text.length<20)continue;
        const timeEls=[...article.querySelectorAll('a[aria-label],abbr[title],time,[aria-label]')];
        const timeText=timeEls.map(el=>[el.innerText,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('datetime')].filter(Boolean).join(' ')).join(' ');
        const combined=timeText+" "+text.slice(0,700);
        if(!isRecent24h(combined))continue;
        const reactions=parseMetric(text,"reactions"),comments=parseMetric(text,"comments"),shares=parseMetric(text,"shares");
        recentPosts.push({time:timeText.trim().slice(0,120)||"Recent timestamp visible; exact time unavailable",reactions,comments,shares,snippet:text.slice(0,260)});
      }
      const known=(key)=>recentPosts.filter(p=>p[key]!=null).length;
      const sum=(key)=>recentPosts.reduce((n,p)=>n+(p[key]||0),0);
      const report={url:groupUrl(location.href),groupName:document.title.replace(/\\s*\\|\\s*Facebook.*$/i,"").trim(),checkedAt:new Date().toISOString(),observedArticles:articles.length,recentPostsFound:recentPosts.length,reactionsTotal:known("reactions")?sum("reactions"):null,commentsTotal:known("comments")?sum("comments"):null,sharesTotal:known("shares")?sum("shares"):null,reactionsPostsCount:known("reactions"),commentsPostsCount:known("comments"),sharesPostsCount:known("shares"),recentPosts:recentPosts.slice(0,30),baseEvidence:evidence(pageText),snippet:pageText.slice(0,1600),blocked:false};
      chrome.runtime.sendMessage({type:"PAGE_DETAILS",...report});return;
    }
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
      found.set(url,{...(old||{}),name,url,snippet:text.slice(0,900),source:"Visible Facebook search result",...evidence(text)});
    }
    chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[...found.values()],blocked:false});
  }
  scan().catch(()=>chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[],blocked:false}));
})();
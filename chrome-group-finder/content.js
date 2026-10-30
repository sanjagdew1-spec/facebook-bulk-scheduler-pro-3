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
      } else if (msg.type === "START_ACTIVITY_CHECK") {
        try {
          const response = await chrome.runtime.sendMessage({type:"START_ACTIVITY_CHECK",group:msg.payload?.group});
          if (!response?.ok) window.postMessage({source:"gfp-chrome-helper",type:"ERROR",error:response?.error||"Could not start group activity check."},WEBSITE_ORIGIN);
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
    if(blocked){
      if(/^\/groups\/[^/]+\/?$/.test(location.pathname)){
        chrome.runtime.sendMessage({type:"PAGE_DETAILS",url:groupUrl(location.href),groupName:document.title,checkedAt:new Date().toISOString(),recentPostsFound:0,recentPosts:[],blocked:true});
      }else chrome.runtime.sendMessage({type:"PAGE_RESULTS",results:[],blocked:true});
      return;
    }
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
      const parseCount=(raw)=>{
        const m=String(raw||"").replace(/,/g,"").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
        if(!m)return null;
        return Math.round(Number(m[1])*({K:1e3,M:1e6,B:1e9}[(m[2]||"").toUpperCase()]||1));
      };
      const metric=(article,kind)=>{
        const labels=[...article.querySelectorAll("[aria-label],[title]")].filter(visible).map(el=>[
          el.getAttribute("aria-label"),el.getAttribute("title"),el.innerText
        ].filter(Boolean).join(" ")).filter(Boolean);
        const text=[article.innerText||"",...labels].join(" ").replace(/\s+/g," ");
        const names=kind==="likes"?"(?:likes?|reactions?|people reacted)":kind==="comments"?"comments?":"shares?";
        const patterns=[
          new RegExp("(\\d[\\d,.]*\\s*[KMB]?)\\s*"+names+"\\b","i"),
          new RegExp("\\b"+names+"\\s*(\\d[\\d,.]*\\s*[KMB]?)","i"),
          new RegExp("(\\d[\\d,.]*\\s*[KMB]?)\\s+(?:people\\s+)?(?:like|comment|share)","i")
        ];
        for(const re of patterns){const m=text.match(re);if(m)return parseCount(m[1]);}
        return null;
      };
      const parseAgeHours=(label,article)=>{
        const now=Date.now();
        const utime=article.querySelector("[data-utime]")?.getAttribute("data-utime");
        if(utime&&/^\d{9,13}$/.test(utime)){
          const n=Number(utime),stamp=n>1e12?n:n*1000;
          const age=(now-stamp)/3600000;
          if(age>=0)return age;
        }
        const dt=article.querySelector("time[datetime]")?.getAttribute("datetime");
        if(dt){const stamp=Date.parse(dt);if(Number.isFinite(stamp)){const age=(now-stamp)/3600000;if(age>=0)return age;}}
        const t=String(label||"").toLowerCase().replace(/\s+/g," ").trim();
        if(/\b(just now|moments? ago|a few seconds ago)\b/.test(t))return 0;
        const rel=t.match(/\b(\d+|a|an|one)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/);
        if(rel){
          const n=/^(a|an|one)$/.test(rel[1])?1:Number(rel[1]);
          const u=rel[2];
          return /^(m|min|mins|minute|minutes)$/.test(u)?n/60:/^(h|hr|hrs|hour|hours)$/.test(u)?n:/^(d|day|days)$/.test(u)?n*24:n*168;
        }
        const dated=t.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?\b/i);
        if(dated){
          let value=dated[0];
          if(!/\d{4}/.test(value))value+=", "+new Date().getFullYear();
          const stamp=Date.parse(value),age=(now-stamp)/3600000;
          if(Number.isFinite(stamp)&&age>=0)return age;
        }
        if(/\byesterday\b/.test(t)){
          const at=t.match(/yesterday(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/);
          const d=new Date();d.setDate(d.getDate()-1);
          if(!at||!at[1])return null;let h=Number(at[1]);if(at[3]==="pm"&&h<12)h+=12;if(at[3]==="am"&&h===12)h=0;d.setHours(h,Number(at[2]||0),0,0);
          const age=(now-d.getTime())/3600000;if(age>=0)return age;
        }
        return null;
      };
      const collected=new Map();
      let scrollSteps=0,articlesObserved=0,uniqueArticleSamples=0,timestampedArticles=0,oldestAgeHours=0,olderThanSevenDaysSeen=false;
      const articleSelector='[role="article"],[data-pagelet*="FeedUnit"]';
      const collectVisiblePosts=()=>{
        const articles=[...document.querySelectorAll(articleSelector)].filter(visible);
        articlesObserved=Math.max(articlesObserved,articles.length);
        uniqueArticleSamples+=articles.length;
        let visibleTimestampAges=[];
        for(const article of articles){
          const timeEls=[...article.querySelectorAll('abbr[title],time,[data-utime],a[aria-label*="ago" i],a[aria-label*="yesterday" i],a[aria-label*=" at " i]')];
          const timeLabel=timeEls.map(el=>[el.innerText,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('datetime')].filter(Boolean).join(" ")).join(" ");
          const age=parseAgeHours(timeLabel,article);
          if(age==null)continue;
          timestampedArticles++;
          visibleTimestampAges.push(age);
          oldestAgeHours=Math.max(oldestAgeHours,age);
          if(age>168){olderThanSevenDaysSeen=true;continue;}
          const key=(timeLabel+"|"+(article.querySelector("[data-ft]")?.getAttribute("data-ft")||article.querySelector('a[href*="/posts/"],a[href*="/permalink/"]')?.getAttribute("href")||"visible-post")+"|"+age.toFixed(2)).replace(/\s+/g," ").slice(0,240);
          if(collected.has(key))continue;
          collected.set(key,{
            postId:key,
            time:timeLabel.trim().slice(0,120)||"Timestamp visible; exact label unavailable",
            ageHours:Math.round(age*10)/10,
            likes:metric(article,"likes"),
            comments:metric(article,"comments"),
            shares:metric(article,"shares")
          });
        }
        return {count:articles.length,oldestVisibleAge:visibleTimestampAges.length?Math.max(...visibleTimestampAges):null,timestampedVisible:visibleTimestampAges.length};
      };
      await sleep(2200);
      let observed=collectVisiblePosts();
      let consecutiveOldBatches=0;
      for(let step=0;step<60;step++){
        const before=window.scrollY;
        window.scrollBy({top:Math.max(420,Math.floor(window.innerHeight*0.68)),behavior:"instant"});
        await sleep(900);
        scrollSteps++;
        observed=collectVisiblePosts();
        if(observed.oldestVisibleAge!=null&&observed.oldestVisibleAge>168)consecutiveOldBatches++;else consecutiveOldBatches=0;
        if(consecutiveOldBatches>=2)break;
        if(window.scrollY===before||window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-5)break;
      }
      const all=[...collected.values()].sort((a,b)=>a.ageHours-b.ageHours);
      const weekPosts=all.filter(p=>p.ageHours>24&&p.ageHours<=168);
      const recentPosts=all.filter(p=>p.ageHours<=24);
      const totals=(posts,key)=>{const known=posts.filter(p=>p[key]!=null);return {count:known.length,total:known.length?known.reduce((n,p)=>n+p[key],0):null};};
      const maxEngagement=(posts)=>{
        if(!posts.length)return null;
        return posts.map(p=>({...p,engagementTotal:[p.likes,p.comments,p.shares].reduce((n,v)=>n+(v||0),0)}))
          .sort((a,b)=>b.engagementTotal-a.engagementTotal)[0];
      };
      const report={
        url:groupUrl(location.href),
        groupName:document.title.replace(/\s*\|\s*Facebook.*$/i,"").trim(),
        checkedAt:new Date().toISOString(),
        recentPostsFound:recentPosts.length,
        recentPosts:recentPosts.map((p,i)=>({postNumber:i+1,time:p.time,ageHours:p.ageHours,likes:p.likes,comments:p.comments,shares:p.shares,postId:p.postId})),
        weekPostsFound:weekPosts.length,
        weekPosts:weekPosts.map((p,i)=>({postNumber:i+1,time:p.time,ageHours:p.ageHours,likes:p.likes,comments:p.comments,shares:p.shares,postId:p.postId})),
        recentTopEngagement:maxEngagement(recentPosts),
        weekTopEngagement:maxEngagement(weekPosts),
        recentTotals:{likes:totals(recentPosts,"likes"),comments:totals(recentPosts,"comments"),shares:totals(recentPosts,"shares")},
        weekTotals:{likes:totals(weekPosts,"likes"),comments:totals(weekPosts,"comments"),shares:totals(weekPosts,"shares")},
        scanDiagnostics:{scrollSteps,articlesObserved,uniqueArticleSamples,timestampedArticles,recentPostsFound:recentPosts.length,weekPostsFound:weekPosts.length,oldestAgeHours:Math.round(oldestAgeHours*10)/10,olderThanSevenDaysSeen},
        blocked:false,
        note:"Only visible post timestamps and visible like/comment/share counts were read. No post was opened and no comment or liker list was inspected."
      };
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
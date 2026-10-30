(() => {
  const WEBSITE_ORIGIN = "https://top-facebook-group-finder-preview.onrender.com";
  if (location.origin === WEBSITE_ORIGIN) {
    if (window.__gfpWebsiteBridge) return;
    window.__gfpWebsiteBridge = true;
    // Clear stale activity state only on the main finder page. Activity Lab must not\n    // clear a newly-created scan job while its startup handshake is in progress.\n    if (location.pathname !== "/activity-lab.html") {\n      chrome.runtime.sendMessage({type:"CLEAR_ACTIVITY_STORAGE"}).catch(()=>{});\n    }
    const sendState = async () => {
      try {
        const state = await chrome.runtime.sendMessage({type:"GET_STATE"});
        window.postMessage({source:"gfp-chrome-helper",type:"STATE",state},WEBSITE_ORIGIN);
      } catch {}
    };
    // Do not cancel an activity scan when the Group Finder page navigates
    // to Activity Lab on the same origin. The previous pagehide event can race
    // with START_ACTIVITY_CHECK and close the newly opened Facebook tab.
    chrome.runtime.onMessage.addListener((message) => {
      if (!message) return;
      // Background forwards the scanner's RAW_ACTIVITY_* messages. Translate
      // them here to the Activity Lab's ACTIVITY_RAW_* browser-message names.
      const translatedType = message.type === "RAW_ACTIVITY_BATCH" ? "ACTIVITY_RAW_BATCH"
        : message.type === "RAW_ACTIVITY_COMPLETE" ? "ACTIVITY_RAW_COMPLETE"
        : message.type;
      if (!["ACTIVITY_RAW_BATCH","ACTIVITY_RAW_COMPLETE","ACTIVITY_RAW_ERROR"].includes(translatedType)) return;
      window.postMessage({source:"gfp-chrome-helper",...message,type:translatedType}, WEBSITE_ORIGIN);
    });
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
      } else if (msg.type === "CANCEL_ACTIVITY_SESSION") {
        try { await chrome.runtime.sendMessage({type:"CANCEL_ACTIVITY_SESSION"}); } catch {}
      } else if (msg.type === "START_ACTIVITY_CHECK") {
        try {
          const response = await chrome.runtime.sendMessage({type:"START_ACTIVITY_CHECK",group:msg.payload?.group,sessionId:msg.payload?.sessionId});
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
      const belongsToPost=(el,article)=>article.matches('[role="article"]')?el.closest('[role="article"]')===article:!el.closest('[role="article"]')&&article.contains(el);
      const postNodes=(article,selector)=>[...article.querySelectorAll(selector)].filter(el=>visible(el)&&belongsToPost(el,article));
      const profileLink=(el)=>{
        let path="";try{path=new URL(el.getAttribute("href")||"",location.origin).pathname;}catch{}
        return /profile\.php|^\/people\//i.test(path)||(/^\/[^/]+\/?$/.test(path)&&!/^\/(groups|pages|watch|marketplace|events|reel|stories|posts|photo|videos)\//i.test(path))||Boolean(el.getAttribute("data-hovercard")||el.getAttribute("data-hovercard-id"));
      };
      // Use the largest visible feed photo/video as the post's visual boundary.
      // Facebook comment avatars are much smaller and therefore cannot become the anchor.
      const mediaAnchor=(article)=>{
        const candidates=postNodes(article,'img,video,[role="img"]')
          .map(el=>({el,r:el.getBoundingClientRect()}))
          .filter(x=>x.r.width>=220&&x.r.height>=130&&x.r.width*x.r.height>=50000)
          .sort((a,b)=>(b.r.width*b.r.height)-(a.r.width*a.r.height));
        return candidates[0]?.el||null;
      };
      const storyBody=(article)=>postNodes(article,'[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]')
        .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0]||null;
      const postHeaderBounds=(article)=>{
        const top=article.getBoundingClientRect().top;
        const media=mediaAnchor(article);
        const story=storyBody(article);
        const boundary=media?media.getBoundingClientRect().top:(story?story.getBoundingClientRect().top:top+220);
        // Header + optional caption may occupy up to ~2.5 inches (240 CSS px)
        // above the main media. Never use timestamps below the media.
        return {top,boundary,lower:Math.max(top-8,boundary-260)};
      };
      const postHeaderTimeNodes=(article)=>{
        const bounds=postHeaderBounds(article);
        // Only timestamps physically inside the main post header are eligible.
        // Anything at/below the media belongs to the comment/action region and is ignored.
        return postNodes(article,'abbr[title],time[datetime],[data-utime],a[aria-label*="ago" i],a[aria-label*="yesterday" i],a[aria-label*=" at " i]')
          .filter(el=>{
            const r=el.getBoundingClientRect();
            return r.top>=bounds.lower&&r.bottom<=bounds.boundary;
          })
          .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
      };
      const commentsBoundary=(article,mediaBottom)=>{
        // "View more comments" is a hard lower boundary: nothing below it
        // may contribute a timestamp, author, action count, or preview.
        const candidates=postNodes(article,'span,div,a,[role="button"]')
          .filter(el=>{
            const r=el.getBoundingClientRect();
            const label=(el.innerText||el.getAttribute("aria-label")||"").replace(/\\s+/g," ").trim().toLowerCase();
            return r.top>=mediaBottom-2&&r.top<mediaBottom+320&&/^view more comments(?:\\s*\\(\\d+\\))?$/.test(label);
          })
          .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
        return candidates[0]?.getBoundingClientRect().top??Infinity;
      };
      const commentComposerBoundary=(article,mediaBottom,cutoff)=>{
        // Secondary structural clue only; never use this as the sole post boundary.
        const candidates=postNodes(article,'textarea,[contenteditable="true"],[aria-label*="comment" i],[placeholder*="comment" i]')
          .filter(el=>{
            const r=el.getBoundingClientRect();
            const label=[el.getAttribute("aria-label"),el.getAttribute("placeholder"),el.innerText].filter(Boolean).join(" ").toLowerCase();
            return r.top>=mediaBottom&&r.top<cutoff&&(/comment as|write a comment|comment/i.test(label)||el.matches("textarea,[contenteditable=true]"));
          }).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
        return candidates[0]?.getBoundingClientRect().top??null;
      };
      const actionKind=(el)=>{
        const label=[el.getAttribute?.("aria-label"),el.getAttribute?.("title"),el.getAttribute?.("data-testid"),el.getAttribute?.("data-tooltip-content"),el.innerText].filter(Boolean).join(" ").replace(/\\s+/g," ").toLowerCase();
        if(/\\b(like|liked|reaction|reactions)\\b/.test(label))return "likes";
        if(/\\b(comment|comments|reply)\\b/.test(label))return "comments";
        if(/\\b(share|shared)\\b/.test(label))return "shares";
        return null;
      };
      const postActionBar=(article)=>{
        const media=mediaAnchor(article);
        const story=storyBody(article);
        const anchor=media||story;
        if(!anchor)return {bar:null,cutoff:Infinity,composer:null,reason:"main-content-not-found"};
        const mediaBottom=anchor.getBoundingClientRect().bottom;
        const cutoff=commentsBoundary(article,mediaBottom);
        const composer=commentComposerBoundary(article,mediaBottom,cutoff);
        // Inspect only the first compact action row immediately under the main media.
        // No node at/after View More Comments is eligible.
        const candidates=postNodes(article,'[role="group"],[role="toolbar"],[role="contentinfo"],div')
          .filter(group=>{
            const r=group.getBoundingClientRect();
            if(r.top<mediaBottom-2||r.top>mediaBottom+145||(Number.isFinite(cutoff)&&r.top>=cutoff))return false;
            const controls=[...group.querySelectorAll('button,[role="button"],a,[aria-label],[title],[data-testid]')]
              .filter(visible);
            const kinds=new Set(controls.map(actionKind).filter(Boolean));
            const text=(group.innerText||"").replace(/\\s+/g," ").trim();
            // A row needs at least two recognizable action controls, or an explicit
            // Facebook action-row test id. This avoids selecting comment text blocks.
            return kinds.size>=2||/ufi_action|post_action|social_actions/i.test(String(group.getAttribute("data-testid")||""));
          })
          .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top||
            a.getBoundingClientRect().height-b.getBoundingClientRect().height);
        const bar=candidates[0]||null;
        return {bar,cutoff,composer,reason:bar?"first-action-row-found":"action-row-not-identifiable"};
      };
      const metric=(article,kind)=>{
        const info=postActionBar(article),bar=info.bar;
        if(!bar)return {value:null,source:info.reason};
        const controls=[...bar.querySelectorAll('button,[role="button"],a,[aria-label],[title],[data-testid]')].filter(visible);
        // Match each count to the actual Like / Comment / Share control, not to
        // arbitrary numbers elsewhere in the post or in its comment thread.
        for(const control of controls){
          if(actionKind(control)!==kind)continue;
          const nearby=[control,control.parentElement,control.parentElement?.parentElement].filter(Boolean);
          for(const el of nearby){
            const r=el.getBoundingClientRect();
            if(Number.isFinite(info.cutoff)&&r.top>=info.cutoff)continue;
            const text=[el.getAttribute?.("aria-label"),el.getAttribute?.("title"),el.innerText].filter(Boolean).join(" ").replace(/\\s+/g," ").trim();
            const counts=[...text.matchAll(/(\\d[\\d,.]*(?:\\s*[KMB])?)/ig)];
            // If a parent contains multiple action counts, it is not a safe association.
            if(counts.length===1)return {value:parseCount(counts[0][1]),source:"icon-control-associated-count"};
          }
          // Sometimes Facebook renders the count in a sibling immediately beside
          // the icon control; only inspect siblings within the same action row.
          for(const sibling of [control.previousElementSibling,control.nextElementSibling]){
            if(!sibling||!visible(sibling)||(Number.isFinite(info.cutoff)&&sibling.getBoundingClientRect().top>=info.cutoff))continue;
            const text=(sibling.innerText||sibling.getAttribute("aria-label")||"").trim();
            const count=text.match(/^(\\d[\\d,.]*(?:\\s*[KMB])?)$/i);
            if(count)return {value:parseCount(count[1]),source:"adjacent-count-in-action-row"};
          }
        }
        return {value:null,source:"icon-count-not-exposed"};
      };
      const postBoundaryInfo=(article)=>{
        const media=mediaAnchor(article);
        if(!media)return {mediaFound:false,viewMoreFound:false,commentComposerFound:false,cardBottom:null,nextPostHeaderFound:false};
        const mediaBottom=media.getBoundingClientRect().bottom;
        const cutoff=commentsBoundary(article,mediaBottom);
        const composer=commentComposerBoundary(article,mediaBottom,cutoff);
        const r=article.getBoundingClientRect();
        const next=article.parentElement?.querySelectorAll?.('[role="article"]')||[];
        const nextHeader=[...next].find(el=>el!==article&&el.getBoundingClientRect().top>r.top&&el.getBoundingClientRect().top<r.bottom);
        return {mediaFound:true,viewMoreFound:Number.isFinite(cutoff),commentComposerFound:composer!=null,cardBottom:Math.round(r.bottom),nextPostHeaderFound:Boolean(nextHeader)};
      };
      const parseAgeHours=(label,article,timeNode)=>{
        const now=Date.now();
        const t=String(label||"").toLowerCase().replace(/\s+/g," ").trim();
        // Facebook's relative label (e.g. 9h, 4d) is the primary age signal.
        if(/\b(just now|moments? ago|a few seconds ago)\b/.test(t))return 0;
        const rel=t.match(/\b(\d+|a|an|one)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/);
        if(rel){
          const n=/^(a|an|one)$/.test(rel[1])?1:Number(rel[1]),u=rel[2];
          return /^(m|min|mins|minute|minutes)$/.test(u)?n/60:/^(h|hr|hrs|hour|hours)$/.test(u)?n:/^(d|day|days)$/.test(u)?n*24:n*168;
        }
        // If no relative age is rendered, use the timestamp attached to that exact time node.
        const utime=timeNode?.getAttribute("data-utime");
        if(utime&&/^\d{9,13}$/.test(utime)){
          const n=Number(utime),stamp=n>1e12?n:n*1000,age=(now-stamp)/3600000;
          if(age>=0)return age;
        }
        const dt=timeNode?.getAttribute("datetime")||timeNode?.getAttribute("title");
        if(dt){const stamp=Date.parse(dt);if(Number.isFinite(stamp)){const age=(now-stamp)/3600000;if(age>=0)return age;}}
        const dated=t.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?\b/i);
        if(dated){let value=dated[0];if(!/\d{4}/.test(value))value+=", "+new Date().getFullYear();const stamp=Date.parse(value),age=(now-stamp)/3600000;if(Number.isFinite(stamp)&&age>=0)return age;}
        if(/\byesterday\b/.test(t)){
          const at=t.match(/yesterday(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/);
          const d=new Date();d.setDate(d.getDate()-1);
          if(!at||!at[1])return null;
          let h=Number(at[1]);if(at[3]==="pm"&&h<12)h+=12;if(at[3]==="am"&&h===12)h=0;
          d.setHours(h,Number(at[2]||0),0,0);const age=(now-d.getTime())/3600000;if(age>=0)return age;
        }
        return null;
      };
      const postAuthor=(article)=>{
        const bounds=postHeaderBounds(article);
        // The publisher is the first profile identity in the header above the media.
        // Anything after the media boundary (including commenters) is excluded.
        const candidates=postNodes(article,"a[href],[data-ad-rendering-role='profile_name'],[data-testid*='post_author' i]")
          .map(el=>({
            label:(el.innerText||el.getAttribute("aria-label")||"").replace(/\s+/g," ").trim(),
            y:el.getBoundingClientRect().top,
            profile:el.matches("a[href]")?profileLink(el):true
          }))
          .filter(x=>x.profile&&x.label.length>=2&&x.label.length<=90&&x.y>=bounds.lower&&x.y<bounds.boundary)
          .sort((x,y)=>x.y-y.y);
        return candidates[0]?.label||"Not available";
      };
      const postPreview=(article)=>{
        // Only read the main story text before the main media / comment cutoff.
        // Never fall back to article text, which can contain nested comments.
        const media=mediaAnchor(article);
        const story=storyBody(article);
        if(!media)return story?(story.innerText||"").replace(/\\s+/g," ").trim().slice(0,220)||"Not available":"Not available";
        const mediaTop=media.getBoundingClientRect().top;
        const cutoff=commentsBoundary(article,media.getBoundingClientRect().bottom);
        const nodes=postNodes(article,'[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]')
          .filter(el=>el.getBoundingClientRect().bottom<=mediaTop&&el.getBoundingClientRect().top<cutoff);
        const value=nodes.map(el=>(el.innerText||"").replace(/\s+/g," ").trim()).find(t=>t.length>0);
        return value?value.slice(0,220):"Not available";
      };
      const collected=new Map();
      let nextFeedOrder=1;
      let scrollSteps=0,articlesObserved=0,uniqueArticleSamples=0,timestampedArticles=0,oldestAgeHours=0,olderThanSevenDaysSeen=false,authorsIdentified=0,authorsUnavailable=0,nestedArticlesExcluded=0,mediaAnchorsFound=0,viewMoreBoundariesFound=0,commentComposersFound=0,actionRowsFound=0;
      let rawBatchSequence=0;
      const captureRawDomBatch=async()=>{
        // Send visible DOM evidence to Activity Lab without classifying posts here.
        // Nested comment cards are structurally retained but their text/labels are redacted.
        const feed=document.querySelector('[role="main"]')||document.body;
        const feedUnits=[...feed.querySelectorAll('[data-pagelet*="FeedUnit"]')].filter(visible);
        const articleRoots=[...feed.querySelectorAll('[role="article"]')].filter(visible)
          .filter(el=>!el.parentElement?.closest('[role="article"]'));
        const dataFtRoots=[...feed.querySelectorAll('[data-ft]')].filter(visible)
          .filter(el=>!el.parentElement?.closest('[data-ft]'));
        const roots=articleRoots.length?articleRoots.slice(0,3):(feedUnits.length?feedUnits.slice(0,3):dataFtRoots.slice(0,3));
        const snapshots=[];
        for(const root of roots){
          const clone=root.cloneNode(true);
          const nested=[...clone.querySelectorAll('[role="article"]')];
          nested.forEach((node,index)=>{
            // Keep the first main article's content; redact nested comment/reply bodies.
            if(index===0&&!clone.matches('[role="article"]'))return;
            const marker=[...node.querySelectorAll('*')].find(el=>/^view more comments$/i.test((el.innerText||'').trim()));
            for(const attr of ['aria-label','title','data-tooltip-content','alt'])node.removeAttribute(attr);
            node.replaceChildren();
            node.setAttribute('data-gfp-comment-content-redacted','true');
            if(marker){const label=document.createElement('span');label.textContent='View More Comments';label.setAttribute('data-gfp-boundary-marker','true');node.appendChild(label);}
          });
          const html=clone.outerHTML||'';
          if(html)snapshots.push({tag:root.tagName,role:root.getAttribute('role')||'',pagelet:root.getAttribute('data-pagelet')||'',html:html.slice(0,45000)});
        }
        const payload={scrollStep:rawBatchSequence++,capturedAt:new Date().toISOString(),pageUrl:location.href,documentTitle:document.title,viewport:{width:innerWidth,height:innerHeight,scrollY},rootCount:snapshots.length,snapshots};
        try{await chrome.runtime.sendMessage({type:'RAW_ACTIVITY_BATCH',payload});}catch{}
      };
      const collectVisiblePosts=()=>{
        // Prefer actual Facebook post articles. FeedUnit wrappers can contain
        // multiple cards and mix one post's timestamp with another post's metrics.
        const allArticles=[...document.querySelectorAll('[role="article"]')].filter(visible);
        // Prefer outermost cards that own their own timestamp. Nested article nodes
        // are often comments/replies, not feed posts. If Facebook wraps the post in
        // an extra article, fall back only to nested cards with an explicit story body.
        const topLevel=allArticles.filter(el=>!el.parentElement?.closest('[role="article"]'));
        const timeSelector='abbr[title],time[datetime],[data-utime],a[aria-label*="ago" i],a[aria-label*="yesterday" i],a[aria-label*=" at " i]';
        // A candidate must look like a complete main feed post: a substantial
        // main photo/video, its own header timestamp above that media, and the
        // visible "View More Comments" cutoff below the first action area.
        // Comment/reply cards do not satisfy this combination and are discarded.
        const isCompleteMainPost=el=>{
          // Accept photo/video posts AND text-only story posts. Requiring a large
          // media element discarded valid Facebook posts and could leave a full
          // 60-step scan with an empty report. Still require a timestamp in the
          // main header; nested comment articles remain excluded by topLevel.
          const hasMainContent=Boolean(mediaAnchor(el)||storyBody(el));
          return hasMainContent&&postHeaderTimeNodes(el).length>0;
        };
        let articles=topLevel.filter(el=>isCompleteMainPost(el));
        if(!articles.length){
          const nestedWithStory=allArticles.filter(el=>
            el.parentElement?.closest('[role="article"]')&&
            postNodes(el,'[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"]').length>0&&
            isCompleteMainPost(el));
          articles=nestedWithStory;
        }
        // Do not fall back to generic FeedUnit wrappers: they can contain
        // multiple posts and nested comment timestamps, which caused false rows.
        nestedArticlesExcluded=Math.max(nestedArticlesExcluded,allArticles.length-articles.length);
        articlesObserved=Math.max(articlesObserved,articles.length);
        uniqueArticleSamples+=articles.length;
        let visibleTimestampAges=[];
        for(const article of articles){
          const boundaryCheck=postBoundaryInfo(article);
          if(boundaryCheck.mediaFound)mediaAnchorsFound++;
          if(boundaryCheck.viewMoreFound)viewMoreBoundariesFound++;
          if(boundaryCheck.commentComposerFound)commentComposersFound++;
          if(postActionBar(article).bar)actionRowsFound++;
          const timeEls=postHeaderTimeNodes(article);
          // Pick the timestamp whose visible text is a relative age (10h, 4d, etc.)
          // before considering an absolute title. This avoids a neighboring card's date.
          const primaryTimeEl=timeEls.find(el=>/\b(?:just now|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks))\b/i.test([el.innerText,el.getAttribute("aria-label")].filter(Boolean).join(" ")))||timeEls[0]||null;
          const relativeLabel=primaryTimeEl?[primaryTimeEl.innerText,primaryTimeEl.getAttribute("aria-label")].filter(Boolean).join(" · ").trim():"";
          // Facebook often exposes the exact hover timestamp in title/aria-label
          // on the time node or its immediate link/container. Keep it separate
          // from the rounded relative label (10h, 8h, etc.).
          const timeMetaNodes=primaryTimeEl?[primaryTimeEl,primaryTimeEl.closest("a"),primaryTimeEl.parentElement,primaryTimeEl.parentElement?.parentElement].filter(Boolean):[];
          const absoluteLabel=[...new Set(timeMetaNodes.flatMap(el=>[el.getAttribute("title"),el.getAttribute("datetime"),el.getAttribute("aria-label"),el.getAttribute("data-tooltip-content")]).filter(Boolean).map(v=>v.replace(/\s+/g," ").trim()).filter(v=>!/^\d+\s*(?:m|min|mins|h|hr|hrs|hour|hours|d|day|days)\b/i.test(v)))].join(" · ").slice(0,220);
          const timeLabel=[relativeLabel,absoluteLabel].filter(Boolean).join(" · ");
          // Parse the calendar date embedded in Facebook's hover timestamp first.
          // The hover aria-label can also contain "10h", so do not let that rounded
          // fragment win over the exact date/time later in the same label.
          const monthDate=absoluteLabel.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?/i);
          const absoluteStamp=monthDate?Date.parse(monthDate[0].replace(/\s+at\s+/i," ")):Date.parse(String(absoluteLabel||"").replace(/\s+at\s+/i," "));
          const exactAgeHours=Number.isFinite(absoluteStamp)?(Date.now()-absoluteStamp)/3600000:null;
          // The visible relative label on the main header is the primary age
          // signal (e.g. 12h). Ancestor hover metadata can belong to a different
          // nested element, so an absolute date must never override that label.
          const relativeAge=parseAgeHours(relativeLabel,article,primaryTimeEl);
          const age=relativeAge!=null?relativeAge:(exactAgeHours!=null&&exactAgeHours>=0?exactAgeHours:parseAgeHours(timeLabel,article,primaryTimeEl));
          if(age==null)continue;
          timestampedArticles++;
          visibleTimestampAges.push(age);
          oldestAgeHours=Math.max(oldestAgeHours,age);
          if(age>168){olderThanSevenDaysSeen=true;continue;}
          const permalink=postNodes(article,'a[href*="/posts/"],a[href*="/permalink/"],a[href*="story_fbid"]')[0]?.getAttribute("href");
          const dataFt=postNodes(article,"[data-ft]")[0]?.getAttribute("data-ft");
          const utime=postNodes(article,"[data-utime]")[0]?.getAttribute("data-utime");
          const datetime=postNodes(article,"time[datetime]")[0]?.getAttribute("datetime");
          const identity=permalink||dataFt||utime||datetime||timeLabel;
          const key=String(identity||"visible-post").replace(/\s+/g," ").slice(0,240);
          if(collected.has(key))continue;
          const author=postAuthor(article);
          if(author==="Not available")authorsUnavailable++;else authorsIdentified++;
          collected.set(key,{
            postId:key,
            postNumber:nextFeedOrder++,
            author,
            preview:postPreview(article),
            relativeTime:relativeLabel.slice(0,80),
            exactTime:absoluteLabel.slice(0,180),
            time:timeLabel.trim().slice(0,220)||"Timestamp visible; exact label unavailable",
            ageHours:Math.round(age*10)/10,
            likes:metric(article,"likes").value,
            comments:metric(article,"comments").value,
            shares:metric(article,"shares").value,
            extractionDiagnostics:{
              likeSource:metric(article,"likes").source,
              commentSource:metric(article,"comments").source,
              shareSource:metric(article,"shares").source,
              boundary:postBoundaryInfo(article)
            }
          });
        }
        return {count:articles.length,oldestVisibleAge:visibleTimestampAges.length?Math.max(...visibleTimestampAges):null,timestampedVisible:visibleTimestampAges.length};
      };
      await sleep(2200);
      await captureRawDomBatch();
      let observed=collectVisiblePosts();
      let consecutiveOldBatches=0;
      for(let step=0;step<60;step++){
        const before=window.scrollY;
        window.scrollBy({top:Math.max(420,Math.floor(window.innerHeight*0.68)),behavior:"instant"});
        await sleep(900);
        scrollSteps++;
        await captureRawDomBatch();
        observed=collectVisiblePosts();
        if(observed.oldestVisibleAge!=null&&observed.oldestVisibleAge>168)consecutiveOldBatches++;else consecutiveOldBatches=0;
        if(consecutiveOldBatches>=2)break;
        if(window.scrollY===before||window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-5)break;
      }
      const all=[...collected.values()]; // Preserve original feed order; never sort by age.
      const weekPosts=all.filter(p=>p.ageHours>24&&p.ageHours<=168);
      const recentPosts=all.filter(p=>p.ageHours<=24);
      const totals=(posts,key)=>{const known=posts.filter(p=>p[key]!=null);return {count:known.length,total:known.length?known.reduce((n,p)=>n+p[key],0):null};};
      const maxEngagement=(posts)=>{
        // Unknown metrics are not zero. If no real count was captured, do not
        // manufacture a "highest engagement" post from missing values.
        const scored=posts.map(p=>{
          const known=[p.likes,p.comments,p.shares].filter(v=>v!=null);
          return {...p,engagementTotal:known.length?known.reduce((n,v)=>n+v,0):null,knownMetricCount:known.length};
        }).filter(p=>p.engagementTotal!=null);
        if(!scored.length)return null;
        return scored.sort((a,b)=>b.engagementTotal-a.engagementTotal)[0];
      };
      const report={
        url:groupUrl(location.href),
        groupName:document.title.replace(/\s*\|\s*Facebook.*$/i,"").trim(),
        checkedAt:new Date().toISOString(),
        recentPostsFound:recentPosts.length,
        recentPosts:recentPosts.map((p,index)=>({postNumber:index+1,feedOrder:p.postNumber,author:p.author||"Not available",preview:p.preview||"Not available",relativeTime:p.relativeTime||"",exactTime:p.exactTime||"",time:p.time,ageHours:p.ageHours,likes:p.likes,comments:p.comments,shares:p.shares,postId:p.postId})),
        weekPostsFound:weekPosts.length,
        weekPosts:weekPosts.map((p,index)=>({postNumber:index+1,feedOrder:p.postNumber,author:p.author||"Not available",preview:p.preview||"Not available",relativeTime:p.relativeTime||"",exactTime:p.exactTime||"",time:p.time,ageHours:p.ageHours,likes:p.likes,comments:p.comments,shares:p.shares,postId:p.postId})),
        recentTopEngagement:maxEngagement(recentPosts),
        weekTopEngagement:maxEngagement(weekPosts),
        recentTotals:{likes:totals(recentPosts,"likes"),comments:totals(recentPosts,"comments"),shares:totals(recentPosts,"shares")},
        weekTotals:{likes:totals(weekPosts,"likes"),comments:totals(weekPosts,"comments"),shares:totals(weekPosts,"shares")},
        scanDiagnostics:{scrollSteps,articlesObserved,uniqueArticleSamples,timestampedArticles,authorsIdentified,authorsUnavailable,nestedArticlesExcluded,mediaAnchorsFound,viewMoreBoundariesFound,commentComposersFound,actionRowsFound,recentPostsFound:recentPosts.length,weekPostsFound:weekPosts.length,oldestAgeHours:Math.round(oldestAgeHours*10)/10,olderThanSevenDaysSeen},
        blocked:false,
        note:"Only visible post timestamps and visible like/comment/share counts were read. No post was opened and no comment or liker list was inspected."
      };
      try{await chrome.runtime.sendMessage({type:"RAW_ACTIVITY_COMPLETE",payload:{url:report.url,groupName:report.groupName,checkedAt:report.checkedAt,scrollSteps,rawBatchesSent:rawBatchSequence}});}catch{}
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
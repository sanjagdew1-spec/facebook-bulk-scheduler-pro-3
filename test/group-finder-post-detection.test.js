import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const source=readFileSync(new URL("../chrome-group-finder/content.js",import.meta.url),"utf8");
function rect(top,width,height){return {top,bottom:top+height,left:20,right:20+width,width,height,x:20,y:top,toJSON(){return this;}};}
async function detect(html){
 const dom=new JSDOM(html,{url:"https://www.facebook.com/groups/403062662125374/",runScripts:"outside-only"});
 const w=dom.window,listeners=[];
 Object.defineProperty(w,"innerHeight",{value:900});
 Object.defineProperty(w.HTMLElement.prototype,"innerText",{configurable:true,get(){return this.textContent||"";}});
 w.getComputedStyle=()=>({visibility:"visible",display:"block"});
 w.setTimeout=fn=>{Promise.resolve().then(fn);return 1;};
 w.clearTimeout=()=>{};w.setInterval=()=>1;w.clearInterval=()=>{};
 w.scrollBy=()=>{throw Error("detection must not scroll");};
 w.chrome={runtime:{onMessage:{addListener(fn){listeners.push(fn);},removeListener(fn){const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}},sendMessage:async()=>({ok:true})}};
 for(const el of w.document.querySelectorAll("[data-rect]")){
  const [top,width,height]=el.getAttribute("data-rect").split(",").map(Number);
  el.getBoundingClientRect=()=>rect(top,width,height);
 }
 w.eval(source);
 for(let i=0;i<40&&listeners.length<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(listeners.length>=3,"Facebook detector listener should be registered");
 let result;
 for(const fn of listeners)fn({type:"DETECT_POST_COUNT"},{tab:{id:1}},value=>{result=value;});
 dom.window.close();
 return result;
}
const single=`<!doctype html><title>Group | Facebook</title><body>
 <div role="article" data-rect="100,540,760"><header>Post header</header>
 <div data-ad-preview="message" data-rect="180,500,60">Main post content</div>
 <img data-rect="260,500,400" src="post.jpg">
 <div role="article" data-rect="700,250,80">Nested unrelated card</div></div></body>`;
const double=`<!doctype html><title>Group | Facebook</title><body>
 <div role="article" data-rect="100,540,500"><div data-ad-preview="message">First post</div></div>
 <div role="article" data-rect="620,540,430"><div data-ad-preview="message">Second post</div></div></body>`;
test("detects one visible Main Post and reports its dimensions only",async()=>{
 const result=await detect(single);
 assert.equal(result.ok,true);assert.equal(result.found,true);assert.equal(result.count,1);
 assert.equal(result.label,"SINGLE POST");assert.deepEqual(result.posts,[{number:1,width:540,height:760}]);
});
test("detects two visible Main Posts and caps the result at DOUBLE POST",async()=>{
 const result=await detect(double);
 assert.equal(result.ok,true);assert.equal(result.found,true);assert.equal(result.count,2);
 assert.equal(result.label,"DOUBLE POST");assert.deepEqual(result.posts,[{number:1,width:540,height:500},{number:2,width:540,height:430}]);
});

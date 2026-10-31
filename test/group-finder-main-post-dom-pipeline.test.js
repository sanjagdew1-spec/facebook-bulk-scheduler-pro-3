import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../chrome-group-finder/content.js", import.meta.url), "utf8");
const expected = {
  author: "Fateh",
  preview: "First school you went as a kid in New York",
  relativeTime: "10h",
  likes: 20,
  comments: 62,
  shares: 1,
  photoCount: 1,
  videoCount: 0,
  reactionTypes: ["Like", "Haha"]
};

function makeRect(top, width, height) {
  return { x: 40, y: top, top, left: 40, right: 40 + width, bottom: top + height,
    width, height, toJSON() { return this; } };
}

function makeFacebookPostDom() {
  return `<!doctype html><html><head><title>I grew up in New York | Facebook</title></head><body>
    <main>
      <div role="article" id="main-post" data-rect="100,550,850">
        <header>
          <a href="/fateh" data-rect="140,220,28">Fateh</a>
          <abbr title="October 30, 2026 at 3:30 PM" data-rect="178,60,18">10h</abbr>
        </header>
        <div data-ad-preview="message" data-rect="220,480,54">First school you went as a kid in New York</div>
        <img alt="Photo attached to the post" src="https://example.invalid/post-photo.jpg" data-rect="350,500,300">
        <div role="group" data-rect="655,500,44">
          <div><button aria-label="Like" data-rect="660,90,32">20</button></div>
          <div><button aria-label="Comment" data-rect="660,110,32">62</button></div>
          <div><button aria-label="Share" data-rect="660,90,32">1</button></div>
          <img alt="Like" src="https://example.invalid/like.png" data-rect="660,18,18">
          <img alt="Haha" src="https://example.invalid/haha.png" data-rect="660,18,18">
        </div>
        <section aria-label="Comments" data-rect="730,500,180">
          <div role="article" data-rect="740,500,90">
            <a href="/commenter-private-name" data-rect="745,180,20">Commenter Private Name</a>
            <p data-rect="770,400,30">Private comment text must never be captured.</p>
            <button aria-label="Like" data-rect="805,70,20">Like</button>
            <button aria-label="Reply" data-rect="805,70,20">Reply</button>
          </div>
        </section>
      </div>
    </main>
  </body></html>`;
}

async function runActualContentScriptAgainstDom() {
  const dom = new JSDOM(makeFacebookPostDom(), {
    url: "https://www.facebook.com/groups/403062662125374/",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const listeners = new Set();
  const messages = [];
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  window.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  window.setTimeout = (fn) => { Promise.resolve().then(fn); return 1; };
  window.clearTimeout = () => {};
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  window.scrollBy = () => { throw new Error("One-post capture must never scroll."); };
  window.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); }
      },
      sendMessage: async message => {
        messages.push(message);
        return { ok: true, forwarded: true };
      }
    }
  };
  for (const el of window.document.querySelectorAll("[data-rect]")) {
    const [top, width, height] = el.getAttribute("data-rect").split(",").map(Number);
    el.getBoundingClientRect = () => makeRect(top, width, height);
  }
  window.eval(source);
  // Wait until the real content script has registered its manual-capture listener.
  for (let i = 0; i < 30 && listeners.size < 2; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(listeners.size >= 2, "content.js must register the actual Facebook capture listener");
  for (const listener of [...listeners]) listener({ type: "CAPTURE_ONE_POST" });
  for (let i = 0; i < 30 && !messages.some(m => m.type === "RAW_ACTIVITY_BATCH"); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const batch = messages.find(m => m.type === "RAW_ACTIVITY_BATCH");
  const complete = messages.find(m => m.type === "RAW_ACTIVITY_COMPLETE");
  const details = messages.find(m => m.type === "PAGE_DETAILS");
  dom.window.close();
  return { batch, complete, details, messages };
}

test("real content.js DOM extraction reads the reference post, not a hardcoded sample payload", async () => {
  const { batch, complete, details, messages } = await runActualContentScriptAgainstDom();
  assert.ok(batch, "actual content.js must send RAW_ACTIVITY_BATCH; diagnostics=" + JSON.stringify({complete,details,messageTypes:messages.map(m=>m.type)}));
  assert.equal(batch.payload.fixture, undefined, "this payload must not use the SAMPLE fixture path");
  assert.equal(batch.payload.captureMode, "main-post-records-v1");
  assert.equal(batch.payload.posts.length, 1);
  const post = batch.payload.posts[0];
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(post[key], value, key);
  assert.equal(post.mainPostVerified, true);
  assert.equal(post.commentTextCaptured, false);
  assert.equal(complete.payload.postsFound, 1);
  assert.equal(details.recentPostsFound, 1);
  assert.equal(details.recentPosts[0].author, expected.author);
  assert.equal(details.recentPosts[0].likes, expected.likes);
  const serialized = JSON.stringify(batch.payload);
  assert.equal(serialized.includes("Commenter Private Name"), false);
  assert.equal(serialized.includes("Private comment text"), false);
});

test("the extension-to-website bridge forwards the structured batch using the Activity Lab event name", () => {
  assert.match(source, /message\.type === "RAW_ACTIVITY_BATCH" \? "ACTIVITY_RAW_BATCH"/);
  assert.match(source, /window\.postMessage\(\{source:"gfp-chrome-helper",\.\.\.message,type:translatedType\}, WEBSITE_ORIGIN\)/);
  const background = readFileSync(new URL("../chrome-group-finder/background.js", import.meta.url), "utf8");
  assert.match(background, /chrome\.tabs\.sendMessage\(a\.websiteTabId,\{type:msg\.type,payload,sessionId:a\.sessionId\}\)/);
  assert.match(background, /msg\.type==="RAW_ACTIVITY_BATCH"\|\|msg\.type==="RAW_ACTIVITY_COMPLETE"/);
});


test("the actual deployed Activity Lab accepts the extracted batch and renders the post plus scan diagnostics", async () => {
  const html = readFileSync(new URL("./activity-lab-under-test.html", import.meta.url), "utf8");
  const { batch, complete } = await runActualContentScriptAgainstDom();
  assert.ok(batch, "content.js must produce a real structured batch before the website test starts");
  const dom = new JSDOM(html, {
    url: "https://group-finder-pro-main-post-v2-preview.onrender.com/activity-lab.html?groupName=I%20grew%20up%20in%20New%20York&groupUrl=https%3A%2F%2Fwww.facebook.com%2Fgroups%2F403062662125374%2F&sessionId=dom-pipeline-test",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const storedBatches = [];
  let timerId = 0;
  window.fetch = async (url, options = {}) => {
    const value = String(url);
    if (options.method === "POST" && value.includes("/batches")) {
      storedBatches.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false }) };
    }
    if (value.endsWith("/api/activity/sessions/dom-pipeline-test")) {
      return { ok: true, status: 200, json: async () => ({ batches: storedBatches, rawChunks: {}, uniqueChunkCount: 0, storedBytes: 0 }) };
    }
    throw new Error("Unexpected Activity Lab test request: " + value);
  };
  window.setTimeout = () => ++timerId;
  window.clearTimeout = () => {};
  window.setInterval = () => ++timerId;
  window.clearInterval = () => {};
  const inlineScripts = [...window.document.querySelectorAll("script")].map(node => node.textContent).filter(Boolean);
  assert.ok(inlineScripts.length, "the deployed Activity Lab must include its working page script");
  for (const script of inlineScripts) window.eval(script);
  const dispatch = data => window.dispatchEvent(new window.MessageEvent("message", {
    data: { source: "gfp-chrome-helper", ...data },
    origin: window.location.origin,
    source: window
  }));
  dispatch({ type: "ACTIVITY_RAW_BATCH", payload: batch.payload });
  dispatch({ type: "ACTIVITY_RAW_COMPLETE", payload: complete.payload });
  for (let i = 0; i < 60 && window.document.getElementById("activityStatus").textContent !== "ANALYSIS COMPLETE"; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(storedBatches.length, 1, "Activity Lab must upload the extension's exact structured batch");
  assert.equal(storedBatches[0].posts[0].author, expected.author);
  assert.equal(window.document.getElementById("activityStatus").textContent, "ANALYSIS COMPLETE");
  const rows = window.document.getElementById("activityRows").textContent;
  for (const value of [expected.author, expected.preview, "10h", "Like, Haha", "20", "62", "1"]) {
    assert.ok(rows.includes(value), "rendered Activity Lab row must contain " + value + "; got: " + rows);
  }
  const summary = window.document.getElementById("activitySummary").textContent;
  assert.match(summary, /DOM role=article nodes:/);
  assert.match(summary, /Main-content candidates:/);
  assert.match(summary, /Header timestamp candidates:/);
  assert.match(summary, /Main action-row candidates:/);
  assert.equal(rows.includes("Commenter Private Name"), false);
  assert.equal(rows.includes("Private comment text"), false);
  dom.window.close();
});

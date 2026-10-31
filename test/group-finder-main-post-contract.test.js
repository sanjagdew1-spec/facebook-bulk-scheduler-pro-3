import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../chrome-group-finder/content.js", import.meta.url), "utf8");

test("capture sends only newly discovered verified Main Posts", () => {
  assert.match(content, /const sentMainPostKeys=new Set\(\)/);
  assert.match(content, /const unsentPosts=\[\.\.\.collected\.values\(\)\]\.filter/);
  assert.match(content, /posts:unsentPosts\.map\(post=>\(\{\.\.\.post,commentTextCaptured:false\}\)\)/);
  assert.match(content, /for\(const post of unsentPosts\)sentMainPostKeys\.add/);
  assert.doesNotMatch(content, /sentMainPostKey=""/);
});

test("post recognition does not require comments or a View more comments boundary", () => {
  const start = content.indexOf("const isCompleteMainPost=el=>{");
  const end = content.indexOf("let articles=topLevel.filter", start);
  assert.ok(start >= 0 && end > start, "Main Post candidate predicate exists");
  const predicate = content.slice(start, end);
  assert.match(predicate, /hasMainContent&&postHeaderTimeNodes\(el\)\.length>0&&Boolean\(postActionBar\(el\)\.bar\)/);
  assert.doesNotMatch(predicate, /viewMore|commentsBoundary|View more comments/i);
  assert.match(content, /posts with zero comments must pass the same recognition rules/i);
});

test("first-post test reads exactly one visible Main Post and never scrolls", () => {
  assert.match(content, /if\(collected\.size>=1\)break/);
  assert.match(content, /for\(let attempt=0;attempt<5&&collected\.size===0;attempt\+\+\)/);
  const groupScan = content.slice(content.indexOf("if(isGroupPage){"));
  const report = groupScan.indexOf("const all=[...collected.values()]");
  assert.ok(report > 0, "group scan report is generated after the one-post capture");
  const captureFlow = groupScan.slice(0, report);
  assert.doesNotMatch(captureFlow, /scrollBy|scrollTop\s*\+=|for\(let step=0;step<60/);
  assert.match(content, /const all=\[\.\.\.collected\.values\(\)\]\.filter\(p=>p\.mainPostVerified===true\)/);
});

test("comment text and commenter identities are not part of the capture payload", () => {
  const start = content.indexOf("const captureRawDomBatch=async()=>{");
  const end = content.indexOf("const collectVisiblePosts=()=>{", start);
  const capture = content.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(capture, /captureMode:"main-post-records-v1"/);
  assert.match(capture, /commentTextCaptured:false/);
  assert.doesNotMatch(capture, /outerHTML|innerHTML|commenter|commentText\s*:/i);
});

test("image-only Main Posts are accepted even when caption text is unavailable", () => {
  assert.match(content, /const mediaCounts=postMediaCounts\(article\)/);
  assert.match(content, /preview==="Not available"&&mediaCounts\.photoCount===0&&mediaCounts\.videoCount===0/);
});
 
test("extension sends the documented structured Main Post payload", () => {
  assert.match(content, /captureMode:"main-post-records-v1"/);
  assert.match(content, /mainPostVerified:true/);
  assert.match(content, /commentTextCaptured:false/);
  assert.match(content, /reactionTypes:postReactionTypes\(article\)/);
});

test("the built-in Fateh fixture matches the supplied Main Post reference", () => {
  assert.match(content, /author:"Fateh"/);
  assert.match(content, /preview:"First school you went as a kid in New York"/);
  assert.match(content, /relativeTime:"10h", time:"10h", ageHours:10/);
  assert.match(content, /likes:20, comments:62, shares:1/);
  assert.match(content, /photoCount:1, videoCount:0, reactionTypes:\["Like","Haha"\]/);
  assert.match(content, /commentTextCaptured:false/);
});

test("one-post capture waits for the toolbar button and a ten-second manual positioning countdown", () => {
  assert.match(content, /message\?\.type!==\"CAPTURE_ONE_POST\"/);
  assert.match(content, /setTimeout\(\(\)=>\{clearInterval\(ticker\);overlay\.remove\(\);resolveManualCapture\(\);\},10000\)/);
  assert.match(content, /chrome\.runtime\.onMessage\.addListener\(captureMessageListener\)/);
  assert.match(content, /chrome\.runtime\.onMessage\.removeListener\(captureMessageListener\)/);
  const groupScan = content.slice(content.indexOf("if(isGroupPage){"), content.indexOf("const all=[...collected.values()]"));
  assert.doesNotMatch(groupScan, /scrollBy|scrollTop\s*\+=/);
});
test("selected post candidates are on-screen and ranked toward viewport center", () => {
  assert.match(content, /el\.getBoundingClientRect\(\)\.bottom>0&&el\.getBoundingClientRect\(\)\.top<innerHeight/);
  assert.match(content, /const viewportCenter=innerHeight\/2/);
});

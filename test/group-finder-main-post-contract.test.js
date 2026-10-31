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

test("scan continues after its first post and retains every verified post", () => {
  assert.doesNotMatch(content, /if\(collected\.size>0\)break/);
  assert.match(content, /const all=\[\.\.\.collected\.values\(\)\]\.filter\(p=>p\.mainPostVerified===true\)/);
  assert.doesNotMatch(content, /mainPostVerified===true\)\.slice\(0,1\)/);
  assert.match(content, /if\(olderThanSevenDaysSeen\)break/);
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

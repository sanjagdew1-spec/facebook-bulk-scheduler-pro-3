import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lab = readFileSync(new URL("../group-finder/activity-lab.html", import.meta.url), "utf8");

test("Activity Lab accepts verified structured Main Post records", () => {
  assert.match(lab, /captureMode!=='main-post-records-v1'/);
  assert.match(lab, /data\.mainPostVerified!==true/);
  assert.match(lab, /structuredPostsReceived\+=batch\.posts\.length/);
  assert.match(lab, /structuredPostsAccepted\+\+;/);
});

test("Activity Lab keeps main post metrics and visible reaction types", () => {
  assert.match(lab, /likes:data\.likes!=null&&Number\.isFinite\(Number\(data\.likes\)\)/);
  assert.match(lab, /comments:data\.comments!=null&&Number\.isFinite\(Number\(data\.comments\)\)/);
  assert.match(lab, /shares:data\.shares!=null&&Number\.isFinite\(Number\(data\.shares\)\)/);
  assert.match(lab, /reactionTypes:Array\.isArray\(data\.reactionTypes\)/);
  assert.match(lab, /photoCount:Number\(data\.photoCount\)\|\|0/);
});

test("Activity Lab does not need comment text or a comments preview to accept a post", () => {
  const start = lab.indexOf("for(const data of batch.posts)");
  const end = lab.indexOf("const extractMetric=", start);
  assert.ok(start >= 0 && end > start);
  const accept = lab.slice(start, end);
  assert.doesNotMatch(accept, /commentText|commenter|View more comments/i);
  assert.match(accept, /data\.mainPostVerified!==true/);
  assert.match(accept, /data\.ageHours==null/);
  assert.match(accept, /const photoCount=Number\(data\.photoCount\)\|\|0/);
  assert.match(accept, /&&photoCount===0&&videoCount===0/);
  assert.doesNotMatch(accept, /if\(!preview\|\|preview==='Not available'\)continue/);
});

test("fixture data contract is represented in the website test button", () => {
  assert.match(lab, /runFixtureTest/);
  assert.match(lab, /RUN_FIXTURE_TEST/);
  assert.match(lab, /main-post-records-v1/);
  assert.match(lab, /Sending the built-in one-post fixture through the Extension bridge/);
  assert.match(lab, /Run SAMPLE fixture only · does not scan Facebook/);
  assert.match(lab, /FIXTURE ONLY · NOT A LIVE SCAN/);
  assert.match(lab, /SAMPLE FIXTURE ONLY — no Facebook Group was opened or scanned/);
});

test("one Main Post is rendered as one row with main post engagement fields", () => {
  assert.match(lab, /<th>Posted by<\/th>/);
  assert.match(lab, /<th>Post preview<\/th>/);
  assert.match(lab, /<th>Likes<\/th>/);
  assert.match(lab, /<th>Comments<\/th>/);
  assert.match(lab, /<th>Shares<\/th>/);
  assert.match(lab, /<th>Reactions<\/th>/);
});

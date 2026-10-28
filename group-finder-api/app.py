import json, os, re, time, urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree as ET

PORT = int(os.environ.get("PORT", "10000"))
UA = "Mozilla/5.0 (compatible; GroupFinderPrototype/1.0; public search results)"

def fetch_keyword(keyword, country, min_members, priority, extra):
    query = 'site:facebook.com/groups ' + keyword + (' ' + extra if extra else '')
    if min_members >= 1000:
        query += ' ' + str(min_members // 1000) + 'k members'
    if country and country != "Worldwide":
        query += ' "' + country + '"'
    if priority in ("high", "very high", "recent posts"):
        query += ' active posts discussions'
    elif priority == "largest communities":
        query += ' members community'
    url = "https://www.bing.com/search?format=rss&count=20&q=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml,application/xml,text/xml"})
    try:
        with urllib.request.urlopen(req, timeout=18) as response:
            raw = response.read(1_500_000)
        root = ET.fromstring(raw)
    except Exception as exc:
        return [], str(exc)
    found = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        description = re.sub(r"<[^>]+>", " ", item.findtext("description") or "")
        description = re.sub(r"\s+", " ", description).strip()
        parsed = urllib.parse.urlparse(link)
        if "facebook.com" not in parsed.netloc.lower() or "/groups/" not in parsed.path.lower():
            continue
        link = urllib.parse.urlunparse((parsed.scheme or "https", parsed.netloc, parsed.path.rstrip("/"), "", "", ""))
        blob = title + " " + description
        member_match = re.search(r"(\d[\d,.]*\s*(?:k|m)?\s*(?:members|member|people|followers))", blob, re.I)
        members = None
        if member_match:
            val = re.search(r"([\d,.]+)\s*([km]?)", member_match.group(1), re.I)
            if val:
                try:
                    members = int(float(val.group(1).replace(",", "")) * (1000 if val.group(2).lower()=="k" else 1000000 if val.group(2).lower()=="m" else 1))
                except Exception:
                    members = None
        posts_match = re.search(r"(\d+)\s*(?:posts?|discussions?)\s*(?:in|over|during|within)?\s*(?:the\s*)?(?:last\s*)?(24\s*hours?|day|daily)", blob, re.I)
        posts_day = int(posts_match.group(1)) if posts_match else None
        activity_clues = []
        for term in ("active", "recent posts", "new posts", "daily discussion", "posts today", "very active"):
            if term in blob.lower():
                activity_clues.append(term)
        score = None
        if posts_day is not None:
            score = min(100, round(posts_day / 100 * 100)) 
        found.append({
            "keyword": keyword, "name": title or "Facebook Group", "url": link,
            "snippet": description[:600], "members": members, "postsPerDay": posts_day,
            "activityScore": score, "activityClues": activity_clues,
            "source": "Bing public web index", "verifiedLive": False
        })
    return found, None

class Handler(BaseHTTPRequestHandler):
    def _send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        self._send(200, {"ok": True})
    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            return self._send(200, {"ok": True, "service": "group-finder-search-api", "source": "Bing public web index", "limitations": "Indexed public search results only; membership/activity metrics are shown only when explicitly present in source snippets."})
        return self._send(404, {"error":"Not found"})
    def do_POST(self):
        if self.path.rstrip("/") != "/api/search":
            return self._send(404, {"error":"Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 2_000_000:
                return self._send(413, {"error":"Request too large"})
            data = json.loads(self.rfile.read(length) or b"{}")
            keywords = data.get("keywords", [])
            if isinstance(keywords, str):
                keywords = re.split(r"[\n,;]+", keywords)
            keywords = list(dict.fromkeys(str(x).strip() for x in keywords if str(x).strip()))
            if not keywords:
                return self._send(400, {"error":"Enter at least one keyword or phrase."})
            country = str(data.get("country") or "United States").strip()
            priority = str(data.get("activityPriority") or "very high").lower()
            extra = str(data.get("extraKeywords") or "").strip()
            try: min_members = int(data.get("minimumMembers") or 0)
            except Exception: min_members = 0
        except Exception:
            return self._send(400, {"error":"Invalid JSON request."})
        groups, errors = [], []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(fetch_keyword, kw, country, min_members, priority, extra): kw for kw in keywords}
            for future in as_completed(futures):
                kw = futures[future]
                try:
                    rows, error = future.result()
                    groups.extend(rows)
                    if error: errors.append({"keyword":kw,"message":"Public search source could not be reached for this phrase."})
                except Exception:
                    errors.append({"keyword":kw,"message":"Search failed for this phrase."})
        unique, seen = [], set()
        for g in groups:
            if g["url"] in seen: continue
            seen.add(g["url"])
            unique.append(g)
        unique.sort(key=lambda g: (g["postsPerDay"] is not None, g["postsPerDay"] or -1, g["members"] is not None, g["members"] or -1), reverse=True)
        return self._send(200, {
            "ok": True, "source": "Bing public web index", "keywordsProcessed": len(keywords),
            "resultCount": len(unique), "groups": unique, "errors": errors,
            "notice": "These are public indexed search candidates, not a complete Facebook directory. Facebook may hide group details; member counts and posts/day are only shown when the source explicitly exposes them. No estimated or invented metrics are used."
        })
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

if __name__ == "__main__":
    print("Group Finder API listening on", PORT, flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

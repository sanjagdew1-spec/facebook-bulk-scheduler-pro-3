import html, json, os, re, time, urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree as ET

PORT = int(os.environ.get("PORT", "10000"))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

class AnchorParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.current = None
    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            attrs = dict(attrs)
            href = attrs.get("href", "")
            if href:
                self.current = {"href": href, "text": [attrs.get("aria-label", "")]}
    def handle_data(self, data):
        if self.current is not None and data.strip():
            self.current["text"].append(data.strip())
    def handle_endtag(self, tag):
        if tag.lower() == "a" and self.current is not None:
            self.links.append((self.current["href"], " ".join(self.current["text"]).strip()))
            self.current = None

def normalize_group_url(raw):
    try:
        raw = html.unescape(raw.strip())
        if raw.startswith("//"):
            raw = "https:" + raw
        # Search engines sometimes HTML/percent-encode the destination URL inside
        # their result href or embedded JSON. Decode only until a URL is visible.
        for _ in range(3):
            if re.match(r"^https?://", raw, re.I) or raw.startswith("//"):
                break
            decoded = urllib.parse.unquote(raw)
            if decoded == raw:
                break
            raw = decoded
        p = urllib.parse.urlparse(raw)
        # Unwrap common search-engine redirect URLs before validating Facebook links.
        for _ in range(3):
            host0 = p.netloc.lower().split(":")[0]
            qs = urllib.parse.parse_qs(p.query)
            unwrapped = ""
            if host0.endswith("duckduckgo.com") and p.path.startswith("/l/"):
                unwrapped = (qs.get("uddg") or qs.get("url") or [""])[0]
            elif host0.endswith("google.com") and p.path == "/url":
                unwrapped = (qs.get("q") or qs.get("url") or [""])[0]
            elif host0.endswith("search.yahoo.com"):
                # Yahoo result redirects commonly carry the destination in RU=.
                match = re.search(r"(?:^|/)RU=([^/]+)", p.path, re.I)
                if match:
                    unwrapped = urllib.parse.unquote(match.group(1))
            elif host0.endswith("bing.com") and p.path.startswith("/ck/a"):
                candidate = (qs.get("u") or [""])[0]
                if candidate.startswith("a1"):
                    try:
                        import base64
                        unwrapped = base64.urlsafe_b64decode(candidate[2:] + "=" * (-len(candidate[2:]) % 4)).decode("utf-8", "ignore")
                    except Exception:
                        unwrapped = ""
                elif candidate.startswith("http"):
                    unwrapped = candidate
            if not unwrapped or unwrapped == raw:
                break
            raw = urllib.parse.unquote(unwrapped)
            p = urllib.parse.urlparse(raw)
        host = p.netloc.lower().split(":")[0]
        if host.startswith("www."):
            host = host[4:]
        if host != "facebook.com" and not host.endswith(".facebook.com"):
            return None
        if "/groups/" not in p.path.lower():
            return None
        path = p.path.rstrip("/")
        # Keep group root, discard post and query fragments.
        m = re.search(r"(/groups/[^/]+)", path, re.I)
        if not m:
            return None
        return "https://www.facebook.com" + m.group(1) + "/"
    except Exception:
        return None

def parse_count(blob):
    member_match = re.search(r"(\d[\d,.]*\s*(?:k|m)?\s*(?:members|member|people|followers))", blob, re.I)
    members = None
    if member_match:
        val = re.search(r"([\d,.]+)\s*([km]?)", member_match.group(1), re.I)
        if val:
            try:
                members = int(float(val.group(1).replace(",", "")) * (1000 if val.group(2).lower()=="k" else 1000000 if val.group(2).lower()=="m" else 1))
            except Exception:
                pass
    posts_match = re.search(r"(\d+)\s*(?:posts?|discussions?)\s*(?:in|over|during|within)?\s*(?:the\s*)?(?:last\s*)?(24\s*hours?|day|daily)", blob, re.I)
    posts_day = int(posts_match.group(1)) if posts_match else None
    return members, posts_day

def parse_results(provider, raw, query):
    rows = []
    try:
        raw_text = raw.decode("utf-8", "ignore") if isinstance(raw, bytes) else str(raw)
        if provider == "SearXNG":
            payload = json.loads(raw_text)
            entries = [(str(item.get("title") or ""), str(item.get("url") or ""), str(item.get("content") or item.get("snippet") or "")) for item in payload.get("results", []) if isinstance(item, dict)]
        elif provider == "Bing RSS":
            root = ET.fromstring(raw)
            entries = [(item.findtext("title") or "", item.findtext("link") or "", item.findtext("description") or "") for item in root.findall(".//item")]
        elif provider == "Jina Google":
            # Jina Reader returns search pages as Markdown/plain text, not HTML.
            entries = []
            for title, href in re.findall(r"\[([^\]]{1,240})\]\((https?://[^)\s]+)\)", raw_text):
                entries.append((title, href, ""))
            for href in re.findall(r"https?://(?:www\.)?facebook\.com/groups/[A-Za-z0-9_.%/?=&-]+", raw_text, re.I):
                entries.append(("", href, ""))
        else:
            parser = AnchorParser()
            parser.feed(raw_text)
            entries = []
            for href, label in parser.links:
                # Get nearby anchor text from source for the name/snippet where possible.
                entries.append((label, href, ""))
        # Some engines embed Facebook destinations in JSON/script markup instead
        # of ordinary result anchors. Scan those URLs too, including escaped forms.
        raw_text = raw.decode("utf-8", "ignore") if isinstance(raw, bytes) else str(raw)
        raw_text = html.unescape(raw_text)
        # Search results often JSON-escape URLs as https:\\/\\/... or use \\u002F.
        raw_text = re.sub(r"\\u002f", "/", raw_text, flags=re.I)
        raw_text = raw_text.replace(r"\/", "/").replace(r"\\/", "/")
        raw_text = raw_text.replace(r"\u003a", ":").replace(r"\\u003a", ":")
        # Decode encoded search-result URLs before extracting group roots.
        decoded_text = urllib.parse.unquote(raw_text)
        embedded = re.findall(
            r"(?:https?://)?(?:www\.)?facebook\.com/groups/([A-Za-z0-9_.%-]+)",
            decoded_text, re.I
        )
        for slug in embedded:
            entries.append(("", "https://www.facebook.com/groups/" + slug + "/", ""))
        for title, raw_url, description in entries:
            # Google and some HTML search results use relative redirect paths.
            if raw_url.startswith("/"):
                base_host = {
                    "Google": "https://www.google.com",
                    "Google Web": "https://www.google.com",
                    "Brave Search": "https://search.brave.com",
                    "Mojeek": "https://www.mojeek.com",
                    "DuckDuckGo": "https://html.duckduckgo.com",
                    "DuckDuckGo Lite": "https://lite.duckduckgo.com",
                    "Startpage": "https://www.startpage.com",
                    "Yahoo": "https://search.yahoo.com"
                }.get(provider, "")
                raw_url = base_host + raw_url
            url = normalize_group_url(raw_url)
            if not url:
                continue
            title = html.unescape(re.sub(r"<[^>]+>", " ", title or "")).strip()
            description = html.unescape(re.sub(r"<[^>]+>", " ", description or ""))
            description = re.sub(r"\s+", " ", description).strip()
            if not title or title.lower() in ("facebook", "log in or sign up"):
                title = "Facebook Group · " + urllib.parse.unquote(url.rstrip("/").split("/")[-1])
            members, posts_day = parse_count(title + " " + description)
            blob = (title + " " + description).lower()
            clues = [term for term in ("active", "recent posts", "new posts", "daily discussion", "posts today", "very active") if term in blob]
            rows.append({
                "keyword": query, "name": title[:240], "url": url,
                "snippet": description[:600], "members": members, "postsPerDay": posts_day,
                "activityScore": min(100, posts_day) if posts_day is not None else None,
                "activityClues": clues, "source": provider, "verifiedLive": False
            })
    except Exception as exc:
        print("PARSE_ERROR", provider, type(exc).__name__, flush=True)
    return rows

def request_source(provider, query):
    encoded = urllib.parse.quote(query)
    if provider == "SearXNG":
        endpoints = (("https://" + "search.jeremyh.xyz/search?q=" + encoded + "&format=json&language=en-US"), ("https://" + "searx.rhscz.eu/search?q=" + encoded + "&format=json&language=en-US"), ("https://" + "searxng.buffon.cloud/search?q=" + encoded + "&format=json&language=en-US"), ("https://" + "search.liuzj.net/search?q=" + encoded + "&format=json&language=en-US"))
        last_error = None
        for endpoint in endpoints:
            try:
                req = urllib.request.Request(endpoint, headers={"User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9"})
                with urllib.request.urlopen(req, timeout=8) as response:
                    raw = response.read(2_000_000)
                payload = json.loads(raw.decode("utf-8", "ignore"))
                if not isinstance(payload.get("results"), list):
                    raise ValueError("Unexpected SearXNG JSON shape")
                rows = parse_results(provider, raw, query)
                print("SEARCH_SOURCE", provider, "endpoint", urllib.parse.urlparse(endpoint).netloc, "bytes", len(raw), "results", len(payload["results"]), "candidates", len(rows), flush=True)
                if rows:
                    return rows
            except Exception as exc:
                last_error = exc
                print("SEARCH_PROVIDER_ERROR", provider, urllib.parse.urlparse(endpoint).netloc, type(exc).__name__, flush=True)
        if last_error:
            raise last_error
        return []
    elif provider == "Bing RSS":
        url = "https://www.bing.com/search?format=rss&count=30&q=" + encoded
        accept = "application/rss+xml,application/xml,text/xml"
    elif provider == "Jina Google":
        # Read Google's public result page through Jina Reader, which returns a
        # text/Markdown representation when direct HTML scraping is blocked.
        url = "https://r.jina.ai/http://www.google.com/search?q=" + encoded + "&num=20"
        accept = "text/plain,text/markdown,*/*"
    elif provider == "DuckDuckGo Lite":
        url = "https://lite.duckduckgo.com/lite/?q=" + encoded
        accept = "text/html,application/xhtml+xml"
    elif provider == "Startpage":
        url = "https://www.startpage.com/sp/search?query=" + encoded
        accept = "text/html,application/xhtml+xml"
    elif provider == "DuckDuckGo":
        url = "https://html.duckduckgo.com/html/?q=" + encoded
        accept = "text/html,application/xhtml+xml"
    elif provider == "Brave Search":
        url = "https://search.brave.com/search?q=" + encoded + "&source=web"
        accept = "text/html,application/xhtml+xml"
    elif provider == "Google Web":
        url = "https://www.google.com/search?udm=14&num=30&q=" + encoded
        accept = "text/html,application/xhtml+xml"
    elif provider == "Mojeek":
        url = "https://www.mojeek.com/search?q=" + encoded
        accept = "text/html,application/xhtml+xml"
    elif provider == "Yahoo":
        url = "https://search.yahoo.com/search?p=" + encoded
        accept = "text/html,application/xhtml+xml"
    else:
        url = "https://www.google.com/search?num=30&q=" + encoded
        accept = "text/html,application/xhtml+xml"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=9) as response:
        raw = response.read(2_000_000)
    rows = parse_results(provider, raw, query)
    print("SEARCH_SOURCE", provider, "bytes", len(raw), "facebook_mentions", raw.decode("utf-8", "ignore").lower().count("facebook.com"), "group_mentions", raw.decode("utf-8", "ignore").lower().count("/groups"), "candidates", len(rows), flush=True)
    return rows

def fetch_keyword(keyword, country, min_members, priority, extra):
    # Preserve broad discovery without serially spending 9 seconds on each query.
    # Try the two strongest variants together; only run fallback variants if needed.
    base = " ".join(x for x in [keyword, extra] if x).strip()
    location = "USA" if country == "United States" else ("" if country == "Worldwide" else country)
    variants = [
        (base + " Facebook groups " + location).strip(),
        ("Facebook groups " + base + " " + location).strip(),
        ("facebook.com/groups " + base).strip(),
        ("site:facebook.com/groups " + base).strip(),
        (base + " groups").strip(),
    ]
    errors = []
    providers = ("Bing RSS", "Google")
    for batch in (variants[:2], variants[2:]):
        found = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {
                pool.submit(request_source, provider, query): (provider, query)
                for query in batch for provider in providers
            }
            for future in as_completed(futures):
                provider, query = futures[future]
                try:
                    found.extend(future.result())
                except Exception as exc:
                    errors.append(provider + ":" + type(exc).__name__)
                    print("SEARCH_PROVIDER_ERROR", provider, type(exc).__name__, "query", query[:100], flush=True)
        if found:
            unique, seen = [], set()
            for row in found:
                if row["url"] not in seen:
                    seen.add(row["url"])
                    unique.append(row)
            print("KEYWORD_RESULTS", keyword, "queries", len(batch), "count", len(unique), flush=True)
            return unique, None
    return [], ",".join(sorted(set(errors))) or "No indexed group URLs in provider responses"

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
    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            return self._send(200, {"ok": True, "service": "group-finder-search-api", "sources": ["Mojeek public web index", "Brave Search public web index", "Google public web index", "Bing public web index", "DuckDuckGo public web index", "Yahoo public web index"], "limitations": "Indexed public search results only; membership/activity metrics are shown only when explicitly present in source snippets."})
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
            try:
                min_members = int(data.get("minimumMembers") or 0)
            except Exception:
                min_members = 0
        except Exception:
            return self._send(400, {"error":"Invalid JSON request."})
        print("SEARCH_REQUEST", "keywords", len(keywords), "country", country, "priority", priority, flush=True)
        groups, errors = [], []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(fetch_keyword, kw, country, min_members, priority, extra): kw for kw in keywords}
            for future in as_completed(futures):
                kw = futures[future]
                try:
                    rows, error = future.result()
                    groups.extend(rows)
                    if error:
                        errors.append({"keyword":kw,"message":"Public search providers returned no usable group link (" + error + ")."})
                except Exception as exc:
                    print("KEYWORD_ERROR", kw, type(exc).__name__, flush=True)
                    errors.append({"keyword":kw,"message":"Search failed for this phrase."})
        unique, seen = [], set()
        for group in groups:
            if group["url"] in seen:
                continue
            seen.add(group["url"])
            unique.append(group)
        unique.sort(key=lambda g: (g["postsPerDay"] is not None, g["postsPerDay"] or -1, g["members"] is not None, g["members"] or -1), reverse=True)
        print("SEARCH_COMPLETE", "processed", len(keywords), "results", len(unique), "errors", len(errors), flush=True)
        return self._send(200, {
            "ok": True, "source": "Mojeek, Brave Search, Google, Bing, DuckDuckGo and Yahoo public web indexes",
            "keywordsProcessed": len(keywords), "resultCount": len(unique), "groups": unique, "errors": errors,
            "notice": "These are public indexed search candidates, not a complete Facebook directory. Facebook may hide group details; member counts and posts/day are only shown when the source explicitly exposes them. No estimated or invented metrics are used."
        })
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

if __name__ == "__main__":
    print("Group Finder API listening on", PORT, flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

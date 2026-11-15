#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Fetch the official German road-sign graphics (StVO / VzKat) from Wikimedia Commons.

    python3 -I tools/signs/fetch-signs.py [--prune] [--interval SECONDS] [--user-agent UA]
                                          [--first CODES] [--max-wait SECONDS] [--no-download]

Input   tools/signs/sign-sources.json  { code: { commonsFile, title, shape, note? } }
Output  public/signs/svg/<code>.svg    the Commons original, byte for byte
        public/signs/manifest.json     { code: { title, commonsFile, sourceUrl, license,
                                                 width, height, shape } }
        public/signs/signs.json        { code: "<svg ...>" } - cleaned, minified copies

A sign is only accepted if the Commons licence metadata says "Public domain" (German
road signs are official works, § 5 Abs. 1 UrhG) and the file is a sane, self-contained
SVG below 400 kB. Everything else is skipped and listed at the end (exit status 1).

Standard library only. Re-runs are cheap: an existing svg/<code>.svg whose SHA-1 still
matches the one reported by Commons is not downloaded again. signs.json and manifest.json
are refreshed after every few downloads and whenever the run ends or is stopped (Ctrl-C,
kill, a rate-limit penalty longer than --max-wait), so they always describe everything
that is verified on disk so far.

Rate limits: upload.wikimedia.org throttles bulk downloads of original files by clients
it cannot identify. In November 2026 it answered the default User-Agent below with
"429 Too many requests - please contact noc@wikimedia.org to discuss a less disruptive
approach or instead use thumbnail images" and a ten-minute Retry-After after 18 files
7 s apart, after 25 files 30 s apart and after 89 files 60 s apart, which fits a
tolerance of about 25 files per 20 minutes and 150 requests per three hours. Hence the
default --interval of 90 s: a first full fetch of about 180 signs takes four and a half
hours, later runs only download what changed. A Retry-After is sat out once; after a
second 429 in a row the run stops and can simply be continued later. Wikimedia documents
higher limits for clients that identify themselves the way its User-Agent policy asks (a
contact URL or e-mail address in the User-Agent, see
https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy); if
that is an option for you, pass it with --user-agent and try a shorter --interval.
"""
import argparse
import hashlib
import http.client
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = HERE / "sign-sources.json"
OUT_DIR = HERE.parent.parent / "public" / "signs"
SVG_DIR = OUT_DIR / "svg"

API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "fahrsim-sign-fetch/0.1 (FOSS driving simulator; one-off asset fetch)"
REQUEST_INTERVAL = 90.0  # seconds between downloads, see "Rate limits" above
API_INTERVAL = 7.0  # seconds between the few API requests (documented: 10 per minute)
MAX_WAIT = 900  # longest Retry-After (seconds) we sit out instead of giving up
WRITE_EVERY = 5  # refresh manifest.json and signs.json after this many downloads
MAX_BYTES = 400_000  # sanity limit for one SVG
SHAPES = ("triangle", "circle", "octagon", "square", "rect", "diamond", "other")
CODE_RE = re.compile(r"(\d+)(?:\.(\d+))?(?:-(\d+))?")

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
# Namespaces that only carry editor state or metadata, never part of the drawing.
EDITOR_NS = (
    "http://www.inkscape.org/namespaces/inkscape",
    "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
    "http://inkscape.sourceforge.net/DTD/sodipodi-0.dtd",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://creativecommons.org/ns#",
    "http://web.resource.org/cc/",
    "http://purl.org/dc/elements/1.1/",
    "http://ns.adobe.com/",
)
# Character data is only rendered (or meaningful) inside these SVG elements.
TEXT_CONTENT = ("text", "tspan", "textPath", "tref", "altGlyph", "title", "desc",
                "style", "script", "foreignObject")
CSS_PX = {"": 1.0, "px": 1.0, "pt": 96 / 72, "pc": 16.0, "mm": 96 / 25.4, "cm": 96 / 2.54, "in": 96.0}


class Skip(Exception):
    """This sign cannot be used; the message says why."""


class NotLocal(Exception):
    """This sign has to be downloaded before it can be checked."""


class GiveUp(Exception):
    """Downloading cannot continue (network trouble or a long rate-limit penalty)."""


# ----------------------------------------------------------------------------- network

client = {"user_agent": USER_AGENT, "interval": REQUEST_INTERVAL, "max_wait": MAX_WAIT,
          "last_download": 0.0, "last_api_request": 0.0}


def http_fetch(url, form=None, limit=None):
    """Download `url`, or POST `form` to the API; throttled, honouring Retry-After on 429/5xx."""
    body = urllib.parse.urlencode(form).encode("utf-8") if form is not None else None
    clock = "last_download" if form is None else "last_api_request"
    throttled = False
    for attempt in range(1, 6):
        pause = client[clock] + (client["interval"] if form is None else API_INTERVAL) - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        client[clock] = time.monotonic()
        request = urllib.request.Request(url, data=body, headers={"User-Agent": client["user_agent"]})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read() if limit is None else response.read(limit)
        except urllib.error.HTTPError as err:
            if err.code not in (429, 500, 502, 503, 504):
                raise
            retry_after = err.headers.get("Retry-After") or ""
            wait = float(retry_after) + 1 if retry_after.isdigit() else 30.0 * attempt
            reason = "HTTP %d %s" % (err.code, err.reason)  # Wikimedia puts its explanation there
            if err.code == 429:  # too fast for our rate-limit class: slow down for good
                client["interval"] = min(client["interval"] * 2, 600.0)
                if throttled:  # still unwelcome after sitting out the penalty: do not insist
                    raise GiveUp(reason + ", for the second time in a row")
                throttled = True
        except (OSError, http.client.HTTPException) as err:
            wait, reason = 30.0 * attempt, repr(err)
        if wait > client["max_wait"]:
            raise GiveUp("%s, told to wait %.0f s" % (reason, wait))
        print("  %s - waiting %.0f s" % (reason, wait), file=sys.stderr, flush=True)
        time.sleep(wait)
    raise GiveUp("no success after 5 attempts: " + url)


def commons_imageinfo(titles):
    """Map each title to its Commons page record (None if missing); follows redirects."""
    result = {}
    for start in range(0, len(titles), 50):  # the API takes at most 50 titles per request
        chunk = titles[start:start + 50]
        form = {
            "action": "query", "format": "json", "formatversion": "2", "maxlag": "5",
            "redirects": "1", "prop": "imageinfo",
            "iiprop": "url|size|mime|sha1|extmetadata",
            "iiextmetadatafilter": "LicenseShortName|License|UsageTerms|Copyrighted",
            "titles": "|".join(chunk),
        }
        for _ in range(10):
            data = json.loads(http_fetch(API, form))
            if data.get("error", {}).get("code") != "maxlag":
                break
            time.sleep(5)  # the database servers are lagging, be patient
        if "error" in data:
            raise GiveUp("Commons API error: %s" % data["error"])
        query = data["query"]
        alias = {}
        for step in ("normalized", "redirects"):
            for entry in query.get(step, []):
                alias[entry["from"]] = entry["to"]
        pages = {page["title"]: page for page in query.get("pages", [])}
        for title in chunk:
            resolved = title
            for _ in range(3):  # title normalisation, then a redirect
                resolved = alias.get(resolved, resolved)
            result[title] = pages.get(resolved)
    return result


# ----------------------------------------------------------------------------- checks


def licence_of(info):
    """Return the Commons LicenseShortName if the file is public domain, else raise Skip."""
    meta = {key: str(value.get("value") or "").strip() for key, value in info.get("extmetadata", {}).items()}
    short = meta.get("LicenseShortName", "")
    public_domain = short.lower() == "public domain" or meta.get("License", "").lower() == "pd"
    if not public_domain or meta.get("Copyrighted", "").lower() == "true":
        raise Skip("not public domain (LicenseShortName=%r, License=%r, Copyrighted=%r)"
                   % (short, meta.get("License", ""), meta.get("Copyrighted", "")))
    return short or "Public domain"


def split_tag(tag):
    if tag.startswith("{"):
        namespace, _, name = tag[1:].partition("}")
        return namespace, name
    return "", tag


def parse_svg(data):
    """Sanity-check the raw bytes and return the parsed root element."""
    if len(data) >= MAX_BYTES:
        raise Skip("larger than %d bytes" % MAX_BYTES)
    head = data[3:] if data.startswith(b"\xef\xbb\xbf") else data
    if not head.lstrip().startswith((b"<?xml", b"<svg")):
        raise Skip("does not start with <?xml or <svg")
    # xml.etree expands internal entities; only tolerate the short, flat ones that
    # Adobe Illustrator writes for its namespaces (no entity-expansion bombs).
    for entity in re.findall(rb"<!ENTITY\s+[^>]*>", data):
        if not re.fullmatch(rb'<!ENTITY\s+[\w.-]+\s+(?:"[^"&%]{0,200}"|\'[^\'&%]{0,200}\')\s*>', entity):
            raise Skip("unexpected entity declaration")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as err:
        raise Skip("not well-formed XML (%s)" % err)
    if root.tag != "{%s}svg" % SVG_NS:
        raise Skip("root element is not <svg>")
    for elem in root.iter():
        name = split_tag(elem.tag)[1]
        if name == "script":
            raise Skip("contains a <script> element")
        if elem.text and name == "style" and re.search(r"@import|url\(\s*[\"']?(?!#|data:)", elem.text):
            raise Skip("style sheet references an external resource")
        for attr, value in elem.attrib.items():
            attr_name = split_tag(attr)[1]
            if re.fullmatch(r"on[a-z]+", attr_name):
                raise Skip("contains an event handler attribute (%s)" % attr_name)
            if attr_name == "href" and not value.strip().startswith(("#", "data:image/")):
                raise Skip("references an external resource (%s)" % value[:60])
            if re.search(r"url\(\s*[\"']?(?!#|data:)", value):
                raise Skip("references an external resource (%s)" % value[:60])
    return root


def css_px(value):
    """An absolute SVG length in CSS pixels, or None (missing, relative or unparsable)."""
    match = re.fullmatch(r"\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z]*)\s*", value or "")
    if not match or match.group(2) not in CSS_PX:
        return None
    return float(match.group(1)) * CSS_PX[match.group(2)]


def intrinsic_size(root):
    """Pixel size a browser gives the image: width/height, falling back to the viewBox."""
    width, height = css_px(root.get("width")), css_px(root.get("height"))
    box = [css_px(part) for part in re.split(r"[\s,]+", (root.get("viewBox") or "").strip())]
    if len(box) == 4 and None not in box:
        width = box[2] if width is None else width
        height = box[3] if height is None else height
    if not width or not height or width <= 0 or height <= 0:
        raise Skip("root element has neither width/height nor a viewBox")
    return width, height


# ----------------------------------------------------------------------------- cleaning


def is_editor_ns(namespace):
    return namespace.startswith(EDITOR_NS)


def strip_editor_data(elem):
    """Drop <metadata> and everything in editor namespaces; the drawing is not touched."""
    for attr in [a for a in elem.attrib if is_editor_ns(split_tag(a)[0])]:
        del elem.attrib[attr]
    previous = None
    for child in list(elem):
        namespace, name = split_tag(child.tag)
        if is_editor_ns(namespace) or (namespace == SVG_NS and name == "metadata"):
            if child.tail:  # keep character data that followed the removed element
                if previous is None:
                    elem.text = (elem.text or "") + child.tail
                else:
                    previous.tail = (previous.tail or "") + child.tail
            elem.remove(child)
        else:
            strip_editor_data(child)
            previous = child


def strip_whitespace(elem, in_text=False):
    """Remove whitespace-only character data wherever SVG never renders it."""
    namespace, name = split_tag(elem.tag)
    in_text = in_text or namespace != SVG_NS or name in TEXT_CONTENT
    if not in_text and elem.text and not elem.text.strip():
        elem.text = None
    for child in elem:
        strip_whitespace(child, in_text)
        if not in_text and child.tail and not child.tail.strip():
            child.tail = None


def clean_svg(root, width, height):
    """Serialise a standalone, minified copy without comments, metadata or editor data."""
    strip_editor_data(root)
    strip_whitespace(root)
    root.tail = None
    if root.get("viewBox") is None:  # same picture, but it now also scales when shown at another size
        root.set("viewBox", "0 0 %s %s" % tuple(("%.6f" % size).rstrip("0").rstrip(".") for size in (width, height)))
    text = ET.tostring(root, encoding="unicode")

    def content(tree):
        return [(elem.tag, sorted(elem.attrib.items()), elem.text, elem.tail) for elem in tree.iter()]

    if content(ET.fromstring(text)) != content(root):
        raise Skip("cleaned copy does not survive a parse round trip")
    return text


# ----------------------------------------------------------------------------- main


def sort_key(code):
    main, dot, sub = CODE_RE.fullmatch(code).groups()
    return int(main), int(dot or 0), int(sub) if sub is not None else -1


def write_atomic(path, data):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def write_outputs(found):
    """(Re)write signs.json and manifest.json for every sign verified so far, sorted by code."""
    done = sorted(found, key=sort_key)
    lines = ",\n".join("%s:%s" % (json.dumps(code), json.dumps(found[code][1], ensure_ascii=False))
                       for code in done)
    write_atomic(OUT_DIR / "signs.json", ("{\n" + lines + "\n}\n").encode("utf-8"))
    manifest = {code: found[code][0] for code in done}  # written last: never lists a sign too early
    write_atomic(OUT_DIR / "manifest.json",
                 (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def fetch_sign(code, source, page, state, download):
    """Verify, download (if allowed and needed) and clean one sign -> (manifest entry, cleaned SVG)."""
    if page is None or page.get("missing") or not page.get("imageinfo"):
        raise Skip("no such file on Commons")
    info = page["imageinfo"][0]
    if info.get("mime") != "image/svg+xml":
        raise Skip("not an SVG (%s)" % info.get("mime"))
    licence = licence_of(info)
    if info["size"] >= MAX_BYTES:
        raise Skip("larger than %d bytes" % MAX_BYTES)

    target = SVG_DIR / (code + ".svg")
    data = target.read_bytes() if target.exists() else None
    unchanged = data is not None and hashlib.sha1(data).hexdigest() == info["sha1"]
    if not unchanged:
        if not download:
            raise NotLocal()
        print("  downloading %s" % code, flush=True)
        try:
            data = http_fetch(info["url"], limit=MAX_BYTES + 1)
        except urllib.error.HTTPError as err:
            if err.code not in (404, 410):
                raise GiveUp(str(err))  # e.g. 403: not welcome, leave the remaining files alone
            raise Skip("download failed (HTTP %d)" % err.code)
        if hashlib.sha1(data).hexdigest() != info["sha1"]:
            raise Skip("download does not match the SHA-1 reported by Commons")
    root = parse_svg(data)
    width, height = intrinsic_size(root)
    if abs(width - info["width"]) > 1 or abs(height - info["height"]) > 1:
        print("  note %s: root says %gx%g px, Commons says %dx%d"
              % (code, width, height, info["width"], info["height"]), file=sys.stderr)
    ratio = width / height
    shape = source["shape"]
    if (shape in ("circle", "octagon", "square", "diamond") and abs(ratio - 1) > 0.02) \
            or (shape == "rect" and abs(ratio - 1) <= 0.02) \
            or (shape == "triangle" and not 1.05 < ratio < 1.25):
        print("  note %s: shape %r is unusual for %gx%g px" % (code, shape, width, height), file=sys.stderr)
    cleaned = clean_svg(root, width, height)
    if not unchanged:
        write_atomic(target, data)
    state["unchanged" if unchanged else "downloaded"] += 1
    entry = {
        "title": source["title"],
        "commonsFile": page["title"],
        "sourceUrl": info["descriptionurl"],
        "license": licence,
        "width": round(width),
        "height": round(height),
        "shape": shape,
    }
    return entry, cleaned


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--prune", action="store_true",
                        help="delete svg/*.svg files that no longer belong to a listed sign")
    parser.add_argument("--interval", type=float, default=REQUEST_INTERVAL, metavar="SECONDS",
                        help="pause between downloads (default: %(default)s)")
    parser.add_argument("--user-agent", default=USER_AGENT, metavar="UA",
                        help="User-Agent header (default: %(default)r)")
    parser.add_argument("--first", default="", metavar="CODES",
                        help="comma-separated codes to download before all others")
    parser.add_argument("--max-wait", type=float, default=MAX_WAIT, metavar="SECONDS",
                        help="stop downloading instead of sitting out a longer Retry-After (default: %(default)s)")
    parser.add_argument("--no-download", action="store_true",
                        help="only re-check what is on disk and rewrite manifest.json and signs.json")
    args = parser.parse_args()
    client.update(user_agent=args.user_agent, interval=max(args.interval, 0.5), max_wait=args.max_wait)

    sources = json.loads(SOURCES.read_text(encoding="utf-8"))
    for code, source in sources.items():
        if not CODE_RE.fullmatch(code):
            sys.exit("sign-sources.json: bad code %r" % code)
        if source.get("shape") not in SHAPES or not source.get("title"):
            sys.exit("sign-sources.json: %s needs a title and a shape out of %s" % (code, "|".join(SHAPES)))
        if not re.fullmatch(r"File:[^|#<>\[\]{}]+\.svg", source.get("commonsFile", "")):
            sys.exit("sign-sources.json: %s needs commonsFile \"File:....svg\"" % code)
    codes = sorted(sources, key=sort_key)
    first = list(dict.fromkeys(code for code in args.first.split(",") if code))
    if not set(first) <= set(codes):
        sys.exit("--first: unknown code(s) %s" % ", ".join(sorted(set(first) - set(codes))))

    ET.register_namespace("", SVG_NS)
    ET.register_namespace("xlink", XLINK_NS)
    SVG_DIR.mkdir(parents=True, exist_ok=True)
    print("Asking Commons about %d files ..." % len(codes), flush=True)
    try:
        pages = commons_imageinfo(sorted({sources[code]["commonsFile"] for code in codes}))
    except (GiveUp, urllib.error.HTTPError) as reason:
        sys.exit("Stopped: %s. Nothing was changed." % reason)

    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)  # a plain `kill` ends the run as gracefully as Ctrl-C
    found, skipped, missing = {}, [], []
    state = {"downloaded": 0, "unchanged": 0}

    def attempt(code, download):
        name = sources[code]["commonsFile"]
        try:
            found[code] = fetch_sign(code, sources[code], pages[name], state, download)
        except NotLocal:
            missing.append(code)
        except Skip as reason:
            skipped.append((code, name, str(reason)))

    for code in codes:  # first everything that is already on disk: no download, no waiting
        attempt(code, download=False)
    if found:
        write_outputs(found)
    queue = [code for code in first if code in missing] + [code for code in missing if code not in first]
    stopped = "--no-download" if args.no_download else None
    try:
        for code in [] if args.no_download else queue:  # then the downloads, refreshing the outputs
            attempt(code, download=True)
            if code in found and state["downloaded"] % WRITE_EVERY == 0:
                write_outputs(found)
    except (GiveUp, KeyboardInterrupt) as reason:
        stopped = str(reason) or "interrupted"
    if not found:
        sys.exit("no usable sign at all - leaving the existing output untouched")
    write_outputs(found)

    for path in sorted(path for path in SVG_DIR.glob("*.svg") if path.stem not in found):
        if args.prune:
            path.unlink()
        print("  %s stale file svg/%s" % ("removed" if args.prune else "note:", path.name), file=sys.stderr)

    print("%d of %d signs ok (%d downloaded, %d unchanged), signs.json is %d bytes"
          % (len(found), len(codes), state["downloaded"], state["unchanged"],
             (OUT_DIR / "signs.json").stat().st_size))
    for code, name, reason in skipped:
        print("skipped %s (%s): %s" % (code, name, reason))
    pending = [code for code in queue if code not in found and code not in {entry[0] for entry in skipped}]
    if pending:
        print("Stopped early (%s). Run again later to download the remaining %d signs: %s"
              % (stopped, len(pending), ", ".join(pending)))
    return 1 if skipped or pending else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Regenerate the Publications section of index.html from ORCID (public API).
Usage: python3 scripts/update_pubs.py"""
import json, re, html, urllib.request, collections, pathlib
ORCID = "0000-0003-0261-0737"
def get(url):
    r = urllib.request.Request(url, headers={"Accept": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=30))
works = get(f"https://pub.orcid.org/v3.0/{ORCID}/works")["group"]
items, seen = [], set()
for g in works:
    s = g["work-summary"][0]
    title = (s.get("title") or {}).get("title", {}).get("value", "").strip()
    year = ((s.get("publication-date") or {}).get("year") or {}).get("value", "n.d.")
    journal = (s.get("journal-title") or {}).get("value", "")
    doi = next((e["external-id-value"] for e in (s.get("external-ids") or {}).get("external-id", [])
                if e["external-id-type"] == "doi"), None)
    key = (doi or "").lower() or re.sub(r"\W", "", title.lower())
    if key in seen: continue
    seen.add(key)
    items.append(dict(title=title, year=year, journal=journal, doi=doi, type=s.get("type", "")))
by = collections.defaultdict(list)
for i in items: by[i["year"]].append(i)
out = [f'<p class="note">{len(items)} works from <a href="https://orcid.org/{ORCID}">ORCID</a>. Full author lists are at each DOI.</p>']
for y in sorted(by, reverse=True):
    out.append(f"<h3>{y}</h3>\n<ul class=\"pubs\">")
    for i in by[y]:
        t = html.escape(i["title"]); j = html.escape(i["journal"])
        link = f' <a href="https://doi.org/{html.escape(i["doi"])}">doi:{html.escape(i["doi"])}</a>' if i["doi"] else ""
        out.append(f"<li><span class=\"t\">{t}</span>{'. <em>'+j+'</em>' if j else ''}.{link}</li>")
    out.append("</ul>")
p = pathlib.Path(__file__).resolve().parent.parent / "index.html"
src = p.read_text()
new = re.sub(r"(<!-- PUBS:START -->).*?(<!-- PUBS:END -->)", lambda m: m[1]+"\n"+"\n".join(out)+"\n"+m[2], src, flags=re.S)
p.write_text(new)
print(f"{len(works)} ORCID groups -> {len(items)} unique; missing DOI: {sum(1 for i in items if not i['doi'])}")
for i in items:
    if not i["doi"]: print("  no DOI:", i["year"], i["title"][:80])

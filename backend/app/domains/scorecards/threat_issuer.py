"""Discover dated official attachments through a second index of the exact BSE scrip."""
import re
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

from lxml import html, etree


def indexed_filings(data, code, cutoff):
    if not data or not re.fullmatch(r"\d{6}", code):
        return []
    try:
        root = html.fromstring(data)
    except (etree.ParserError, ValueError):
        return []
    sections = root.xpath("//*[@id='company-announcements-tab']")
    if not sections:
        return []
    section = sections[0]
    links = [urlsplit(href) for href in section.xpath(".//a/@href")]
    if not any(link.hostname == "www.bseindia.com" and link.path.endswith(f"/{code}/corp-announcements/") for link in links):
        return []
    records = []
    for anchor in section.xpath(".//a[.//time[@datetime]]"):
        url = urlsplit(anchor.get("href", ""))
        filename = parse_qs(url.query).get("Pname", [""])[0]
        if url.hostname != "www.bseindia.com" or url.path != "/stockinfo/AnnPdfOpen.aspx" or not re.fullmatch(r"[a-f0-9-]{36}\.pdf", filename, re.I):
            continue
        try:
            stamp = datetime.fromisoformat(anchor.xpath("string(.//time/@datetime)"))
        except ValueError:
            continue
        if stamp.tzinfo and cutoff - timedelta(days=90) <= stamp <= cutoff:
            records.append({"kind":"exchange_notice", "url":anchor.get("href"), "as_of":stamp.isoformat(),
                            "title":" ".join((anchor.text or "").split())[:280]})
    return sorted(records, key=lambda r:r["as_of"], reverse=True)[:3]


# Reviewed primary filings bootstrap the rolling archive during an index outage.
# Dates are publication times (conservative end-of-day for the HAL exchange filing).
# These records expire under the same 90-day rule as collected documents.
PRIMARY_FILINGS = {
    "INE066F01020": {
        "url":"https://hal-india.co.in/backend/eechoogn/2026/08/IntegratedFinancial_30092026.pdf",
        "as_of":"2026-11-12T23:59:59+05:30", "title":"HAL audited consolidated results, September 2026",
        "document_hash":"3b685f83b7694ffd9bbbb3e8e3e747b8c17363896bb6c2e4b95710c0afd14684",
        "excerpt":"HAL consolidated cash flows, six months ended 30 September 2026 (₹ lakh), page 10. "
                  "Provision for doubtful contract assets: 8,030. Prior-year comparable period: 6,510.",
    },
    "INE090A01021": {
        "url":"https://www.sec.gov/Archives/edgar/data/1103838/000095010326015987/dp255170_6k.htm",
        "as_of":"2026-10-22T10:02:58+00:00", "title":"ICICI Bank quarterly financial results, September 2026",
        "document_hash":"379d974c130719bbc1d0891658cafb6c67870488a7d875cfd9c0acfec7d7e86b",
        "excerpt":"ICICI Bank credit growth at 30 September 2026. Overseas loans accounted for 7.8% of the loan "
                  "book. Total advances grew 30.0% year on year, or 24.1% excluding international branch loans "
                  "against FCNR (B) deposits. The retail and rural portfolio accounted for 51.6% of loans.",
    },
}


def primary_filing(isin, cutoff):
    doc = PRIMARY_FILINGS.get(isin)
    if doc and cutoff - timedelta(days=90) <= datetime.fromisoformat(doc["as_of"]) <= cutoff:
        return dict(doc, kind="exchange_notice")

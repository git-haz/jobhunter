import os
import re
import yaml
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

PRESETS_DIR = os.path.join(os.path.dirname(__file__), "platform_presets")
PLUGINS_DIR = os.path.join(os.path.dirname(__file__), "plugins")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

WORK_MODE_KEYWORDS = {
    "remote": ["remote", "fully remote", "work from anywhere", "remote-only"],
    "hybrid": ["hybrid", "partly remote", "flexible"],
    "onsite": ["on-site", "onsite", "office", "in-office", "vor ort"],
}

EMPLOYMENT_TYPE_KEYWORDS = {
    "full-time": ["full-time", "full time", "vollzeit", "permanent", "festanstellung", "unbefristet"],
    "part-time": ["part-time", "part time", "teilzeit"],
    "contract": ["contract", "freelance", "befristet", "temporary"],
    "internship": ["intern", "internship", "praktikum", "werkstudent"],
}

SENIORITY_KEYWORDS = {
    "junior": ["junior", "entry level", "entry-level", "graduate", "berufseinsteiger"],
    "mid": ["mid-level", "mid level", "regular"],
    "senior": ["senior", "lead", "principal", "staff", "head of"],
    "director": ["director", "vp ", "vice president", "c-level", "cto", "cpo"],
}


def load_preset(platform):
    path = os.path.join(PRESETS_DIR, f"{platform}.yaml")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_plugin(filename):
    path = os.path.join(PLUGINS_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_all_plugins():
    plugins = []
    if not os.path.exists(PLUGINS_DIR):
        return plugins
    for fname in os.listdir(PLUGINS_DIR):
        if fname.endswith((".yaml", ".yml")):
            try:
                config = load_plugin(fname)
                config["_filename"] = fname
                plugins.append(config)
            except Exception:
                continue
    return plugins


def fetch_page(url):
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


def extract_text(element):
    if element is None:
        return ""
    return element.get_text(separator=" ", strip=True)


def classify_text(text, keyword_map):
    lower = text.lower()
    for category, keywords in keyword_map.items():
        for kw in keywords:
            if kw in lower:
                return category
    return ""


def extract_salary(text):
    patterns = [
        r'(\d[\d.,]+)\s*[-–]\s*(\d[\d.,]+)\s*(?:€|EUR|USD|\$|GBP|£)',
        r'(?:€|EUR|USD|\$|GBP|£)\s*(\d[\d.,]+)\s*[-–]\s*(\d[\d.,]+)',
        r'(\d{2,3}[.,]\d{3})\s*(?:€|EUR|USD|\$|GBP|£)',
        r'(?:salary|gehalt)[:\s]*(\d[\d.,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(0)
    return ""


def get_favicon_url(base_url):
    domain = urlparse(base_url).netloc
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=64"


def scrape_jobs(plugin_config, fetch_details=True):
    platform = plugin_config.get("platform", "generic")
    preset = load_preset(platform) or {}
    base_url = plugin_config["base_url"].rstrip("/")
    list_cfg = plugin_config.get("jobs_list", preset.get("jobs_list", {}))
    list_path = list_cfg.get("path", "/jobs")
    list_url = base_url + list_path

    soup = fetch_page(list_url)
    link_selector = list_cfg.get("link_selector", "a[href*='/job']")
    links = soup.select(link_selector)

    jobs = []
    seen_urls = set()
    for link in links:
        href = link.get("href", "")
        if not href:
            continue
        job_url = urljoin(list_url, href)
        if job_url in seen_urls:
            continue
        seen_urls.add(job_url)

        external_id = href.rstrip("/").split("/")[-1]

        title_cfg = list_cfg.get("fields", {}).get("title", {})
        title_sel = title_cfg.get("selector", "a") if isinstance(title_cfg, dict) else title_cfg
        title_el = link.select_one(title_sel) if title_sel != "a" else link
        title = extract_text(title_el) or extract_text(link)

        meta_cfg = list_cfg.get("fields", {}).get("meta", {})
        meta_sel = meta_cfg.get("selector", "span") if isinstance(meta_cfg, dict) else meta_cfg
        meta_parts = [extract_text(s) for s in link.find_all(meta_sel if meta_sel != "a" else "span")]
        meta_text = " · ".join(meta_parts)

        location = ""
        department = ""
        work_mode = ""
        for part in meta_parts:
            lower = part.lower()
            if any(w in lower for w in ["remote", "hybrid", "on-site", "onsite", "office"]):
                work_mode = part.strip()
            elif any(w in lower for w in ["germany", "berlin", "munich", "hamburg", "hq", "london", "usa", "new york"]):
                location = part.strip()
            else:
                department = part.strip()

        if not title or title.isspace():
            continue

        job = {
            "external_id": external_id,
            "title": title.strip(),
            "url": job_url,
            "location": location,
            "department": department,
            "work_mode": work_mode or classify_text(meta_text, WORK_MODE_KEYWORDS),
            "employment_type": classify_text(meta_text, EMPLOYMENT_TYPE_KEYWORDS),
            "seniority": classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": "",
            "description": "",
        }

        if fetch_details:
            detail = scrape_job_detail(job_url, platform)
            job["description"] = detail.get("description", "")
            full_text = job["description"] + " " + meta_text
            if not job["work_mode"]:
                job["work_mode"] = classify_text(full_text, WORK_MODE_KEYWORDS)
            if not job["employment_type"]:
                job["employment_type"] = classify_text(full_text, EMPLOYMENT_TYPE_KEYWORDS)
            if not job["seniority"]:
                job["seniority"] = classify_text(job["title"] + " " + full_text, SENIORITY_KEYWORDS)
            job["salary_text"] = extract_salary(full_text)
            if not job["location"] and detail.get("location"):
                job["location"] = detail["location"]

        jobs.append(job)

    return jobs


def scrape_job_detail(job_url, platform="generic"):
    preset = load_preset(platform) or {}
    detail_cfg = preset.get("job_detail", {})

    try:
        soup = fetch_page(job_url)
    except Exception:
        return {}

    result = {}

    # Extract from meta/structured elements first
    for meta in soup.find_all("meta", attrs={"property": True}):
        prop = meta.get("property", "")
        content = meta.get("content", "")
        if "title" in prop:
            result.setdefault("title", content)
        elif "description" in prop:
            result.setdefault("meta_description", content)

    # Try preset selectors
    fields = detail_cfg.get("fields", {})
    for field_name, field_cfg in fields.items():
        if isinstance(field_cfg, dict):
            sel = field_cfg.get("selector", "")
            parent_class = field_cfg.get("parent_class", "")
            if parent_class:
                parent = soup.find(class_=parent_class)
                if parent:
                    result[field_name] = extract_text(parent)
            elif sel:
                el = soup.select_one(sel)
                result[field_name] = extract_text(el)

    # Extract location from common patterns
    if "location" not in result:
        for el in soup.find_all(["span", "div", "p"]):
            text = extract_text(el)
            lower = text.lower()
            if any(city in lower for city in ["berlin", "munich", "hamburg", "london", "new york", "san francisco", "remote"]):
                if len(text) < 100:
                    result["location"] = text
                    break

    # Full description fallback
    if "description" not in result:
        candidates = []
        for tag in ["main", "article", "section"]:
            for el in soup.find_all(tag):
                t = extract_text(el)
                if len(t) > 200:
                    candidates.append(t)
        if candidates:
            result["description"] = max(candidates, key=len)[:5000]
        else:
            body = soup.find("body")
            if body:
                result["description"] = extract_text(body)[:5000]

    return result

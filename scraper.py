import os
import re
import json
import yaml
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

PRESETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "platform_presets")
PLUGINS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")

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


def resolve_nested(data, path):
    """Resolve a dotted/bracketed path like 'items[0].requisitionList' from a dict."""
    parts = re.split(r'\.(?![^\[]*\])', path)
    current = data
    for part in parts:
        bracket = re.match(r'(.+?)\[(\d+)\]', part)
        if bracket:
            key, idx = bracket.group(1), int(bracket.group(2))
            current = current[key][idx]
        else:
            if isinstance(current, dict):
                current = current.get(part, "")
            else:
                return ""
    return current


def apply_scrape_filters(jobs, filters):
    """Filter jobs based on user-set scrape filters."""
    if not filters:
        return jobs

    keyword = (filters.get("keyword") or "").lower().strip()
    location = (filters.get("location") or "").lower().strip()
    work_mode = (filters.get("work_mode") or "").lower().strip()

    filtered = []
    for job in jobs:
        if keyword:
            searchable = f"{job.get('title', '')} {job.get('department', '')} {job.get('description', '')}".lower()
            if keyword not in searchable:
                continue
        if location:
            if location not in job.get("location", "").lower():
                continue
        if work_mode:
            if work_mode not in job.get("work_mode", "").lower():
                continue
        filtered.append(job)
    return filtered


# ---------------------------------------------------------------------------
# HTML-based scrapers (Teamtailor, Personio)
# ---------------------------------------------------------------------------

def scrape_jobs_html(plugin_config, scrape_filters=None):
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
            elif any(w in lower for w in ["germany", "berlin", "munich", "hamburg", "hq", "london",
                                           "usa", "new york", "cologne", "köln", "frankfurt"]):
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

        detail = scrape_job_detail_html(job_url, platform)
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

    return apply_scrape_filters(jobs, scrape_filters)


def scrape_job_detail_html(job_url, platform="generic"):
    preset = load_preset(platform) or {}
    detail_cfg = preset.get("job_detail", {})

    try:
        soup = fetch_page(job_url)
    except Exception:
        return {}

    result = {}

    for meta in soup.find_all("meta", attrs={"property": True}):
        prop = meta.get("property", "")
        content = meta.get("content", "")
        if "title" in prop:
            result.setdefault("title", content)
        elif "description" in prop:
            result.setdefault("meta_description", content)

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

    if "location" not in result:
        for el in soup.find_all(["span", "div", "p"]):
            text = extract_text(el)
            lower = text.lower()
            if any(city in lower for city in ["berlin", "munich", "hamburg", "london",
                                               "new york", "san francisco", "remote",
                                               "cologne", "köln", "frankfurt"]):
                if len(text) < 100:
                    result["location"] = text
                    break

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


# ---------------------------------------------------------------------------
# Workday API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_workday(plugin_config, scrape_filters=None):
    base_url = plugin_config["base_url"].rstrip("/")
    company = plugin_config.get("workday_company", "")
    board = plugin_config.get("workday_board", "")
    api_url = f"{base_url}/wday/cxs/{company}/{board}/jobs"

    search_text = ""
    if scrape_filters:
        parts = []
        if scrape_filters.get("keyword"):
            parts.append(scrape_filters["keyword"])
        if scrape_filters.get("location"):
            parts.append(scrape_filters["location"])
        search_text = " ".join(parts)

    all_jobs = []
    offset = 0
    limit = 20

    while True:
        payload = {
            "appliedFacets": {},
            "limit": limit,
            "offset": offset,
            "searchText": search_text,
        }
        resp = requests.post(api_url, json=payload, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        postings = data.get("jobPostings", [])
        if not postings:
            break

        for p in postings:
            ext_path = p.get("externalPath", "")
            ext_id = ""
            if p.get("bulletFields"):
                ext_id = p["bulletFields"][0]
            elif ext_path:
                ext_id = ext_path.rstrip("/").split("/")[-1]

            title = p.get("title", "")
            location = p.get("locationsText", "")

            job = {
                "external_id": ext_id,
                "title": title,
                "url": f"{base_url}{ext_path}",
                "location": location,
                "department": "",
                "work_mode": classify_text(location + " " + title, WORK_MODE_KEYWORDS),
                "employment_type": "",
                "seniority": classify_text(title, SENIORITY_KEYWORDS),
                "salary_text": "",
                "description": "",
            }

            detail = scrape_job_detail_workday(base_url, company, board, ext_path)
            if detail:
                job["description"] = detail.get("description", "")[:5000]
                job["employment_type"] = detail.get("employment_type", "")
                if not job["work_mode"]:
                    job["work_mode"] = classify_text(
                        job["description"], WORK_MODE_KEYWORDS)
                if detail.get("location") and not job["location"]:
                    job["location"] = detail["location"]
                job["salary_text"] = extract_salary(job["description"])
                if detail.get("department"):
                    job["department"] = detail["department"]

            all_jobs.append(job)

        total = data.get("total", 0)
        offset += limit
        if offset >= total:
            break

    return apply_scrape_filters(all_jobs, scrape_filters)


def scrape_job_detail_workday(base_url, company, board, ext_path):
    if not ext_path:
        return {}
    url = f"{base_url}/wday/cxs/{company}/{board}{ext_path}"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return {}

    info = data.get("jobPostingInfo", {})
    return {
        "title": info.get("title", ""),
        "description": info.get("jobDescription", ""),
        "location": info.get("location", ""),
        "employment_type": info.get("timeType", ""),
        "department": ", ".join(info.get("jobFamilies", [])) if isinstance(info.get("jobFamilies"), list) else "",
    }


# ---------------------------------------------------------------------------
# Oracle HCM API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_oracle_hcm(plugin_config, scrape_filters=None):
    base_url = plugin_config["base_url"].rstrip("/")
    site_number = plugin_config.get("oracle_site_number", "")

    keyword = ""
    if scrape_filters and scrape_filters.get("keyword"):
        keyword = scrape_filters["keyword"]

    all_jobs = []
    offset = 0
    limit = 25

    while True:
        finder_parts = [
            f"siteNumber={site_number}",
            "facetsList=LOCATIONS;WORK_FLEX;TITLES;CATEGORIES;ORGANIZATIONS;POSTING_DATES;FLEX_FIELDS",
            f"limit={limit}",
            f"offset={offset}",
            "lastSelectedFacet=LOCATIONS",
        ]
        if keyword:
            finder_parts.append(f"keyword={keyword}")

        finder = "findReqs;" + ",".join(finder_parts)
        params = {
            "onlyData": "true",
            "expand": "requisitionList.secondaryLocations,flexFieldsFacet.values",
            "finder": finder,
        }

        resp = requests.get(
            f"{base_url}/hcmRestApi/resources/latest/recruitingCEJobRequisitions",
            params=params, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        items = data.get("items", [])
        if not items:
            break

        search_result = items[0]
        req_list = search_result.get("requisitionList", [])
        total = search_result.get("TotalJobsCount", 0)

        if not req_list:
            break

        for req in req_list:
            title = req.get("Title", "")
            location = req.get("PrimaryLocation", "")
            ext_id = str(req.get("Id", ""))
            posted = req.get("PostedDate", "")

            job_url = (f"{base_url}/hcmUI/CandidateExperience/en/sites/"
                       f"{site_number}/job/{ext_id}")

            job = {
                "external_id": ext_id,
                "title": title,
                "url": job_url,
                "location": location,
                "department": "",
                "work_mode": classify_text(title + " " + location, WORK_MODE_KEYWORDS),
                "employment_type": "",
                "seniority": classify_text(title, SENIORITY_KEYWORDS),
                "salary_text": "",
                "description": "",
            }

            detail = scrape_job_detail_oracle_hcm(base_url, site_number, ext_id)
            if detail:
                job["description"] = detail.get("description", "")[:5000]
                if detail.get("employment_type"):
                    job["employment_type"] = detail["employment_type"]
                if not job["work_mode"]:
                    job["work_mode"] = classify_text(
                        job["description"], WORK_MODE_KEYWORDS)
                job["salary_text"] = extract_salary(job["description"])

            all_jobs.append(job)

        offset += limit
        if offset >= total:
            break

    location_filter = ""
    if scrape_filters and scrape_filters.get("location"):
        location_filter = scrape_filters["location"]

    if location_filter:
        all_jobs = [j for j in all_jobs
                    if location_filter.lower() in j.get("location", "").lower()]

    return apply_scrape_filters(all_jobs, scrape_filters)


def scrape_job_detail_oracle_hcm(base_url, site_number, req_id):
    url = (f"{base_url}/hcmRestApi/resources/latest/"
           f"recruitingCEJobRequisitionDetails")
    params = {
        "onlyData": "true",
        "finder": f"findReqDetails;Id={req_id},siteNumber={site_number}",
    }
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return {}

    items = data.get("items", [])
    if not items:
        return {}

    detail = items[0]
    desc_html = detail.get("ExternalDescriptionStr", "")
    if desc_html:
        desc_text = BeautifulSoup(desc_html, "html.parser").get_text(separator=" ", strip=True)
    else:
        desc_text = ""

    return {
        "title": detail.get("Title", ""),
        "description": desc_text,
        "location": detail.get("PrimaryLocation", ""),
        "employment_type": detail.get("WorkType", "") or detail.get("RegularTemporary", ""),
    }


# ---------------------------------------------------------------------------
# Greenhouse API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_greenhouse(plugin_config, scrape_filters=None):
    board_token = plugin_config.get("greenhouse_board_token", "")
    api_url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs"

    params = {"content": "true"}
    resp = requests.get(api_url, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    jobs = []
    for posting in data.get("jobs", []):
        title = posting.get("title", "")
        location = posting.get("location", {}).get("name", "")
        departments = posting.get("departments", [])
        department = departments[0].get("name", "") if departments else ""
        desc_html = posting.get("content", "")
        description = ""
        if desc_html:
            description = BeautifulSoup(desc_html, "html.parser").get_text(
                separator=" ", strip=True)[:5000]

        job = {
            "external_id": str(posting.get("id", "")),
            "title": title,
            "url": posting.get("absolute_url", ""),
            "location": location,
            "department": department,
            "work_mode": classify_text(location + " " + title + " " + description,
                                       WORK_MODE_KEYWORDS),
            "employment_type": classify_text(description, EMPLOYMENT_TYPE_KEYWORDS),
            "seniority": classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": extract_salary(description),
            "description": description,
        }
        jobs.append(job)

    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# SmartRecruiters API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_smartrecruiters(plugin_config, scrape_filters=None):
    company_id = plugin_config.get("smartrecruiters_company", "")
    base_api = "https://api.smartrecruiters.com"

    all_jobs = []
    offset = 0
    limit = 100

    while True:
        params = {"limit": limit, "offset": offset}
        resp = requests.get(
            f"{base_api}/v1/companies/{company_id}/postings",
            params=params, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        postings = data.get("content", [])
        if not postings:
            break

        for p in postings:
            title = p.get("name", "")
            loc = p.get("location", {})
            location = loc.get("city", "")
            country = loc.get("country", "")
            if country and location:
                location = f"{location}, {country}"
            dept = p.get("department", {})
            department = dept.get("label", "") if isinstance(dept, dict) else ""
            emp_type = p.get("typeOfEmployment", {})
            employment_type = emp_type.get("label", "") if isinstance(emp_type, dict) else ""
            exp = p.get("experienceLevel", {})
            experience = exp.get("label", "") if isinstance(exp, dict) else ""

            job_url = p.get("ref", "")
            ext_id = p.get("id", "") or p.get("uuid", "")

            job = {
                "external_id": str(ext_id),
                "title": title,
                "url": job_url,
                "location": location,
                "department": department,
                "work_mode": classify_text(title + " " + location, WORK_MODE_KEYWORDS),
                "employment_type": employment_type or classify_text(title, EMPLOYMENT_TYPE_KEYWORDS),
                "seniority": experience or classify_text(title, SENIORITY_KEYWORDS),
                "salary_text": "",
                "description": "",
            }
            all_jobs.append(job)

        total = data.get("totalFound", 0)
        offset += limit
        if offset >= total:
            break

    return apply_scrape_filters(all_jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Celonis custom API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_celonis(plugin_config, scrape_filters=None):
    api_url = "https://dxp-api.celonis.com/v1/jobs"

    resp = requests.get(api_url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    jobs = []
    for posting in data.get("jobs", []):
        title = posting.get("title", "")
        location = posting.get("groupedLocation", "")
        team = posting.get("team", "")
        seniority = posting.get("seniority", "")
        job_function = posting.get("jobFunction", "")
        job_id = str(posting.get("jobId", ""))

        job = {
            "external_id": job_id,
            "title": title,
            "url": f"https://careers.celonis.com/join-us/open-positions/{job_id}",
            "location": location,
            "department": team,
            "work_mode": classify_text(location + " " + title, WORK_MODE_KEYWORDS),
            "employment_type": posting.get("type", "") or classify_text(title, EMPLOYMENT_TYPE_KEYWORDS),
            "seniority": seniority or classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": "",
            "description": f"{team} - {job_function} - {seniority} - {location}",
        }
        jobs.append(job)

    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

PLATFORM_SCRAPERS = {
    "teamtailor": scrape_jobs_html,
    "personio": scrape_jobs_html,
    "workday": scrape_jobs_workday,
    "oracle_hcm": scrape_jobs_oracle_hcm,
    "greenhouse": scrape_jobs_greenhouse,
    "smartrecruiters": scrape_jobs_smartrecruiters,
    "celonis_api": scrape_jobs_celonis,
}


def scrape_jobs(plugin_config, fetch_details=True, scrape_filters=None):
    platform = plugin_config.get("platform", "generic")
    scraper_fn = PLATFORM_SCRAPERS.get(platform, scrape_jobs_html)
    return scraper_fn(plugin_config, scrape_filters=scrape_filters)

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
    "remote": ["remote", "fully remote", "work from anywhere", "remote-only", "homeoffice", "home office"],
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
# Remotive API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_remotive(plugin_config, scrape_filters=None):
    category = plugin_config.get("remotive_category", "")
    params = {"limit": 200}
    if category:
        params["category"] = category

    search = ""
    if scrape_filters and scrape_filters.get("keyword"):
        params["search"] = scrape_filters["keyword"]

    resp = requests.get("https://remotive.com/api/remote-jobs", params=params,
                        headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    jobs = []
    for p in data.get("jobs", []):
        title = p.get("title", "")
        location = p.get("candidate_required_location", "")
        desc_html = p.get("description", "")
        description = BeautifulSoup(desc_html, "html.parser").get_text(
            separator=" ", strip=True)[:5000] if desc_html else ""
        salary = p.get("salary", "") or ""
        tags = p.get("tags", []) or []

        job = {
            "external_id": str(p.get("id", "")),
            "title": title,
            "url": p.get("url", ""),
            "location": location,
            "department": p.get("category", ""),
            "work_mode": "remote",
            "employment_type": (p.get("job_type", "") or "").replace("_", "-"),
            "seniority": classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": salary,
            "description": description,
        }
        jobs.append(job)

    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Arbeitnow API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_arbeitnow(plugin_config, scrape_filters=None):
    import time as _time
    all_jobs = []
    max_pages = plugin_config.get("max_pages", 3)
    days_posted = plugin_config.get("days_posted", None)
    cutoff_ts = (_time.time() - days_posted * 86400) if days_posted else None

    for page in range(1, max_pages + 1):
        resp = requests.get(f"https://www.arbeitnow.com/api/job-board-api",
                            params={"page": page}, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        listings = data.get("data", [])
        if not listings:
            break

        for p in listings:
            if cutoff_ts and (p.get("created_at") or 0) < cutoff_ts:
                continue
            title = p.get("title", "")
            is_remote = p.get("remote", False)
            tags = p.get("tags", []) or []
            job_types = p.get("job_types", []) or []
            desc_html = p.get("description", "")
            description = BeautifulSoup(desc_html, "html.parser").get_text(
                separator=" ", strip=True)[:5000] if desc_html else ""

            job = {
                "external_id": p.get("slug", ""),
                "title": title,
                "url": p.get("url", ""),
                "location": p.get("location", ""),
                "department": ", ".join(tags[:2]) if tags else "",
                "work_mode": "remote" if is_remote else "",
                "employment_type": ", ".join(job_types) if job_types else "",
                "seniority": classify_text(title, SENIORITY_KEYWORDS),
                "salary_text": "",
                "description": description,
            }
            all_jobs.append(job)

    return apply_scrape_filters(all_jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Himalayas API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_himalayas(plugin_config, scrape_filters=None):
    keyword = ""
    if scrape_filters and scrape_filters.get("keyword"):
        keyword = scrape_filters["keyword"]

    params = {"limit": 50}
    use_search = bool(keyword or (scrape_filters and scrape_filters.get("location")))

    if use_search:
        url = "https://himalayas.app/jobs/api/search"
        if keyword:
            params["query"] = keyword
        if scrape_filters and scrape_filters.get("location"):
            params["country"] = scrape_filters["location"]
    else:
        url = "https://himalayas.app/jobs/api"
        params["offset"] = 0

    resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    jobs = []
    for p in data.get("jobs", []):
        title = p.get("title", "")
        locations = p.get("locationRestrictions", "")
        if isinstance(locations, list):
            locations = ", ".join(locations)
        salary_parts = []
        if p.get("minSalary"):
            salary_parts.append(str(p["minSalary"]))
        if p.get("maxSalary"):
            salary_parts.append(str(p["maxSalary"]))
        salary_text = " - ".join(salary_parts)
        if salary_text and p.get("currency"):
            salary_text += f" {p['currency']}"

        categories = p.get("categories", []) or []
        if isinstance(categories, list):
            categories = ", ".join(categories)

        job = {
            "external_id": p.get("guid", "") or p.get("title", ""),
            "title": title,
            "url": p.get("applicationLink", "") or p.get("guid", ""),
            "location": locations,
            "department": categories,
            "work_mode": "remote",
            "employment_type": p.get("employmentType", "") or "",
            "seniority": p.get("seniority", "") or classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": salary_text,
            "description": (p.get("excerpt", "") or "")[:5000],
        }
        jobs.append(job)

    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Kimeta scraper (heise jobs, golem jobs)
# ---------------------------------------------------------------------------

def scrape_jobs_kimeta(plugin_config, scrape_filters=None):
    base_url = plugin_config["base_url"].rstrip("/")
    search_queries = plugin_config.get("search_queries", [""])

    if scrape_filters and scrape_filters.get("keyword"):
        search_queries = [scrape_filters["keyword"]]

    location = ""
    if scrape_filters and scrape_filters.get("location"):
        location = scrape_filters["location"]

    all_jobs = {}
    for q in search_queries:
        params = {}
        if q:
            params["q"] = q
        if location:
            params["l"] = location

        try:
            resp = requests.get(base_url + "/", params=params, headers=HEADERS, timeout=15)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            for a in soup.find_all("a", href=True):
                href = a.get("href", "")
                if "/job?id=" not in href:
                    continue
                text = a.get_text(strip=True)
                if not text or len(text) < 5:
                    continue
                job_id = href.split("id=")[1].split("&")[0]
                if job_id in all_jobs:
                    continue

                title = text.replace("TOP", "").strip()
                parent = a.find_parent(["div", "li", "article"])
                location_text = ""
                emp_type = ""
                company = ""
                if parent:
                    spans = parent.find_all(["span", "div"])
                    texts = [s.get_text(strip=True) for s in spans if s.get_text(strip=True)]
                    for t in texts:
                        lower = t.lower()
                        if any(w in lower for w in ["vollzeit", "teilzeit", "full", "part"]):
                            emp_type = t
                        elif any(w in lower for w in ["gmbh", "ag", "se ", "e.v.", "kg"]) and not company:
                            company = t
                        elif len(t) < 40 and not location_text and t != title[:len(t)]:
                            location_text = t

                full_url = base_url + href if href.startswith("/") else href
                all_jobs[job_id] = {
                    "external_id": job_id,
                    "title": title,
                    "url": full_url,
                    "location": location_text,
                    "department": "",
                    "work_mode": classify_text(title + " " + location_text, WORK_MODE_KEYWORDS),
                    "employment_type": emp_type or classify_text(title, EMPLOYMENT_TYPE_KEYWORDS),
                    "seniority": classify_text(title, SENIORITY_KEYWORDS),
                    "salary_text": "",
                    "description": title,
                }
        except Exception:
            continue

    jobs = list(all_jobs.values())
    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Arbeitsagentur API scraper (German Federal Employment Agency)
# ---------------------------------------------------------------------------

def scrape_jobs_arbeitsagentur(plugin_config, scrape_filters=None):
    api_headers = {**HEADERS, "X-API-Key": "jobboerse-jobsuche"}
    base = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs"

    keyword = plugin_config.get("default_keyword", "IT")
    location = plugin_config.get("default_location", "")
    radius = plugin_config.get("radius", 25)
    max_pages = plugin_config.get("max_pages", 3)

    if scrape_filters:
        if scrape_filters.get("keyword"):
            keyword = scrape_filters["keyword"]
        if scrape_filters.get("location"):
            location = scrape_filters["location"]

    days = plugin_config.get("days_posted", None)  # e.g. 3 → last 3 days

    all_jobs = []
    for page in range(1, max_pages + 1):
        params = {"was": keyword, "size": 25, "page": page}
        if location:
            params["wo"] = location
            params["umkreis"] = radius
        if days:
            params["veroeffentlichtseit"] = days

        try:
            resp = requests.get(base, params=params, headers=api_headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            break

        listings = data.get("stellenangebote", [])
        if not listings:
            break

        for s in listings:
            title = s.get("titel", "")
            ort = s.get("arbeitsort", {})
            loc = ort.get("ort", "")
            region = ort.get("region", "")
            if region and loc:
                loc = f"{loc}, {region}"

            job = {
                "external_id": s.get("refnr", ""),
                "title": title,
                "url": s.get("externeUrl", "") or f"https://www.arbeitsagentur.de/jobsuche/suche?id={s.get('refnr', '')}",
                "location": loc,
                "department": s.get("beruf", ""),
                "work_mode": classify_text(title + " " + loc, WORK_MODE_KEYWORDS),
                "employment_type": classify_text(title, EMPLOYMENT_TYPE_KEYWORDS),
                "seniority": classify_text(title, SENIORITY_KEYWORDS),
                "salary_text": "",
                "description": f"{title} - {s.get('beruf', '')} - {s.get('arbeitgeber', '')}",
            }
            all_jobs.append(job)

        total = data.get("maxErgebnisse", 0)
        if page * 25 >= total:
            break

    return apply_scrape_filters(all_jobs, scrape_filters)


# ---------------------------------------------------------------------------
# 4dayweek scraper (HTML)
# ---------------------------------------------------------------------------

def scrape_jobs_4dayweek(plugin_config, scrape_filters=None):
    pages = plugin_config.get("pages", ["/remote-jobs/europe"])
    all_jobs = {}

    for page_path in pages:
        url = f"https://4dayweek.io{page_path}"
        try:
            resp = requests.get(url, headers=HEADERS, timeout=15)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            for a in soup.find_all("a", href=True):
                href = a.get("href", "")
                if not href.startswith("/job/"):
                    continue
                text = a.get_text(separator=" ", strip=True)
                if len(text) < 5:
                    continue
                if href in all_jobs:
                    continue

                parent = a.find_parent(["div", "li", "article"])
                company = ""
                location = ""
                if parent:
                    spans = parent.find_all(["span", "p"])
                    for s in spans:
                        t = s.get_text(strip=True)
                        if t and t != text and len(t) < 50:
                            if not company:
                                company = t
                            elif not location:
                                location = t

                all_jobs[href] = {
                    "external_id": href.split("/job/")[-1],
                    "title": text,
                    "url": f"https://4dayweek.io{href}",
                    "location": location or "Remote",
                    "department": "",
                    "work_mode": "remote",
                    "employment_type": "part-time",
                    "seniority": classify_text(text, SENIORITY_KEYWORDS),
                    "salary_text": "",
                    "description": f"{text} - 4-day work week",
                }
        except Exception:
            continue

    jobs = list(all_jobs.values())
    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Workable public API scraper
# ---------------------------------------------------------------------------

def scrape_jobs_workable(plugin_config, scrape_filters=None):
    slug = plugin_config.get("workable_slug", "")
    api_url = f"https://apply.workable.com/api/v3/accounts/{slug}/jobs"
    headers = {
        **HEADERS,
        "Referer": f"https://apply.workable.com/{slug}/",
        "Origin": "https://apply.workable.com",
        "Content-Type": "application/json",
    }
    payload = {"query": "", "location": [], "department": []}
    resp = requests.post(api_url, json=payload, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    all_jobs = []
    for r in data.get("results", []):
        shortcode = r.get("shortcode", "")
        city = r.get("city", "")
        country = r.get("country", "")
        location = ", ".join(filter(None, [city, country]))
        remote = r.get("remote", False)
        work_mode = "remote" if remote else classify_text(location, WORK_MODE_KEYWORDS)

        job = {
            "external_id": r.get("id", shortcode),
            "title": r.get("title", ""),
            "url": f"https://apply.workable.com/{slug}/j/{shortcode}/",
            "location": location,
            "department": r.get("department", ""),
            "work_mode": work_mode,
            "employment_type": classify_text(r.get("employment_type", ""), EMPLOYMENT_TYPE_KEYWORDS),
            "seniority": classify_text(r.get("title", ""), SENIORITY_KEYWORDS),
            "salary_text": "",
            "description": "",
        }
        all_jobs.append(job)

    return apply_scrape_filters(all_jobs, scrape_filters)


# ---------------------------------------------------------------------------
# career.aero HTML scraper (Interpersonal platform — used by Condor etc.)
# ---------------------------------------------------------------------------

def scrape_jobs_career_aero(plugin_config, scrape_filters=None):
    slug = plugin_config.get("career_aero_slug", "")
    base = plugin_config.get("base_url", "https://www.career.aero").rstrip("/")
    list_url = f"{base}/{slug}/en/job/list"

    try:
        resp = requests.get(list_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception:
        return []

    jobs = []
    seen = set()

    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        if f"/{slug}/en/job/show/" not in href and f"/{slug}/de/job/show/" not in href:
            continue
        job_url = urljoin(base, href) if href.startswith("/") else href
        if job_url in seen:
            continue
        seen.add(job_url)

        title_el = a.find("h5") or a.find("h4") or a.find("h3")
        title = title_el.get_text(strip=True) if title_el else a.get_text(strip=True)
        title = title.strip()
        if not title:
            continue

        parent = a.find_parent(["div", "li", "article", "section"])
        location = ""
        if parent:
            for span in parent.find_all(["span", "p", "div"]):
                t = span.get_text(strip=True)
                if t and t != title and 2 < len(t) < 60 and t.lower() not in ("apply", "mehr"):
                    location = t
                    break

        ext_id = href.rstrip("/").split("/")[-1]

        jobs.append({
            "external_id": ext_id,
            "title": title,
            "url": job_url,
            "location": location,
            "department": "",
            "work_mode": classify_text(location + " " + title, WORK_MODE_KEYWORDS),
            "employment_type": classify_text(title, EMPLOYMENT_TYPE_KEYWORDS),
            "seniority": classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": "",
            "description": title,
        })

    return apply_scrape_filters(jobs, scrape_filters)


# ---------------------------------------------------------------------------
# Indeed HTML scraper — parses job cards from search results pages.
# Jobs are identified by the jobkey embedded in card CSS classes (job_XXXX).
# StepStone loads data via client-side JS (public-api requires auth cookies)
# and is not feasible with requests-only scraping.
# ---------------------------------------------------------------------------

def _fetch_indeed_page(base_url, query, location, radius, start, fromage, req_headers):
    """Fetch one Indeed results page; returns list of raw job dicts."""
    params = {
        "q": query,
        "l": location,
        "sort": "date",
        "radius": radius,
        "start": start,
    }
    if fromage:
        params["fromage"] = fromage
    resp = requests.get(f"{base_url}/jobs", params=params, headers=req_headers, timeout=20)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    jobs = []
    for div in soup.find_all("div", class_=re.compile(r"\bresult\b")):
        classes = " ".join(div.get("class", []))
        m = re.search(r'\bjob_([a-f0-9]{16})\b', classes)
        if not m:
            continue
        jk = m.group(1)

        title_el = div.find(["h2", "h3"])
        company_el = div.find(attrs={"data-testid": "company-name"})
        loc_el = div.find(attrs={"data-testid": "text-location"})

        title = title_el.get_text(strip=True) if title_el else ""
        raw_loc = loc_el.get_text(strip=True) if loc_el else ""
        loc = re.sub(r'^(Hybrides Arbeiten in|Vor Ort in|In)\s+', '', raw_loc, flags=re.I).strip()
        job_url = f"{base_url}/viewjob?jk={jk}"
        work_mode = "hybrid" if "hybrid" in raw_loc.lower() else classify_text(raw_loc, WORK_MODE_KEYWORDS)

        jobs.append({
            "jk": jk,
            "external_id": jk,
            "title": title,
            "url": job_url,
            "location": loc,
            "department": "",
            "work_mode": work_mode,
            "employment_type": classify_text(title, EMPLOYMENT_TYPE_KEYWORDS),
            "seniority": classify_text(title, SENIORITY_KEYWORDS),
            "salary_text": "",
            "description": title,
        })
    return jobs


def scrape_jobs_stepstone(plugin_config, scrape_filters=None):
    base_url = plugin_config.get("base_url", "https://www.stepstone.de").rstrip("/")
    queries = plugin_config.get("stepstone_queries", ["product manager"])
    location = plugin_config.get("stepstone_location", "deutschland")
    pages = plugin_config.get("stepstone_pages", 2)

    req_headers = {
        **HEADERS,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": base_url + "/",
    }

    seen_ids = set()
    all_jobs = []

    for query in queries:
        slug = query.lower().replace(" ", "-").replace("/", "-")
        for page in range(1, pages + 1):
            url = f"{base_url}/jobs/{slug}/in-{location}"
            params = {} if page == 1 else {"p": page}
            try:
                resp = requests.get(url, params=params, headers=req_headers, timeout=25)
                resp.raise_for_status()
            except Exception:
                break

            soup = BeautifulSoup(resp.text, "html.parser")
            articles = soup.find_all("article", attrs={"data-at": "job-item"})
            if not articles:
                break

            for art in articles:
                title_el = art.find("a", attrs={"data-testid": "job-item-title"})
                if not title_el:
                    continue
                href = title_el.get("href", "")
                jobid_m = re.search(r"--(\d+)-inline", href)
                if not jobid_m:
                    continue
                job_id = jobid_m.group(1)
                if job_id in seen_ids:
                    continue
                seen_ids.add(job_id)

                title = title_el.get_text(separator=" ", strip=True)

                # Extract metadata: text bits after title are [company, location, work_mode?, ...]
                desc_el = art.find(attrs={"data-at": "job-item-middle"})
                desc_text = desc_el.get_text(separator=" ", strip=True) if desc_el else ""
                bits = [t.strip() for t in art.stripped_strings
                        if t.strip() and t.strip() != title and len(t.strip()) > 1]
                company = bits[0] if len(bits) > 0 else ""
                location_text = bits[1] if len(bits) > 1 else ""
                wm_hint = bits[2] if len(bits) > 2 else ""

                work_mode = classify_text(wm_hint + " " + title, WORK_MODE_KEYWORDS)
                employment_type = classify_text(title, EMPLOYMENT_TYPE_KEYWORDS)
                seniority = classify_text(title, SENIORITY_KEYWORDS)

                job_url = base_url + href if href.startswith("/") else href
                # Canonical URL without -inline suffix
                job_url = job_url.replace("-inline.html", ".html")

                all_jobs.append({
                    "external_id": job_id,
                    "title": title,
                    "company": company,
                    "location": location_text,
                    "url": job_url,
                    "department": "",
                    "work_mode": work_mode,
                    "employment_type": employment_type,
                    "seniority": seniority,
                    "salary_text": "",
                    "description": desc_text,
                })

    return apply_scrape_filters(all_jobs, scrape_filters)


def scrape_jobs_indeed(plugin_config, scrape_filters=None):
    base_url = plugin_config.get("base_url", "https://de.indeed.com").rstrip("/")
    queries = plugin_config.get("indeed_queries", ["product manager"])
    # Support a list of primary locations or a single location
    primary_locations = plugin_config.get("indeed_locations", [plugin_config.get("indeed_location", "Deutschland")])
    fallback_locations = plugin_config.get("indeed_fallback_locations", [])
    fallback_radius = plugin_config.get("indeed_fallback_radius", 100)
    radius = plugin_config.get("indeed_radius", 50)
    pages = plugin_config.get("indeed_pages", 2)
    fromage = plugin_config.get("indeed_fromage", None)

    req_headers = {
        **HEADERS,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    seen_jk = set()
    all_jobs = []

    for query in queries:
        query_found = 0
        for location in primary_locations:
            for page in range(pages):
                try:
                    page_jobs = _fetch_indeed_page(base_url, query, location, radius, page * 10, fromage, req_headers)
                except Exception:
                    break
                new = [j for j in page_jobs if j["jk"] not in seen_jk]
                for j in new:
                    seen_jk.add(j["jk"])
                all_jobs.extend(new)
                query_found += len(new)
                if not page_jobs:
                    break

        # Fallback: if no results found for this query across all primary locations
        if query_found == 0 and fallback_locations:
            for fb_loc in fallback_locations:
                for page in range(pages):
                    try:
                        page_jobs = _fetch_indeed_page(base_url, query, fb_loc, fallback_radius, page * 10, fromage, req_headers)
                    except Exception:
                        break
                    new = [j for j in page_jobs if j["jk"] not in seen_jk]
                    for j in new:
                        seen_jk.add(j["jk"])
                    all_jobs.extend(new)
                    if not page_jobs:
                        break

    # Strip internal 'jk' key before returning
    for j in all_jobs:
        j.pop("jk", None)

    return apply_scrape_filters(all_jobs, scrape_filters)


PLATFORM_SCRAPERS = {
    "teamtailor": scrape_jobs_html,
    "personio": scrape_jobs_html,
    "workday": scrape_jobs_workday,
    "oracle_hcm": scrape_jobs_oracle_hcm,
    "greenhouse": scrape_jobs_greenhouse,
    "smartrecruiters": scrape_jobs_smartrecruiters,
    "celonis_api": scrape_jobs_celonis,
    "remotive": scrape_jobs_remotive,
    "arbeitnow": scrape_jobs_arbeitnow,
    "himalayas": scrape_jobs_himalayas,
    "kimeta": scrape_jobs_kimeta,
    "arbeitsagentur": scrape_jobs_arbeitsagentur,
    "fourday": scrape_jobs_4dayweek,
    "workable": scrape_jobs_workable,
    "career_aero": scrape_jobs_career_aero,
    "indeed": scrape_jobs_indeed,
    "stepstone": scrape_jobs_stepstone,
}


def scrape_jobs(plugin_config, fetch_details=True, scrape_filters=None):
    platform = plugin_config.get("platform", "generic")
    scraper_fn = PLATFORM_SCRAPERS.get(platform, scrape_jobs_html)
    return scraper_fn(plugin_config, scrape_filters=scrape_filters)

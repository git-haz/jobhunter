"""Seed data generator — runs all plugins and saves results as static JSON."""
import os
import re
import sys
import json
import yaml
from datetime import datetime, timezone
from scraper import scrape_jobs

PLUGINS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "jobs.json")
FRAMEWORK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "skills_framework.json")
INFERENCE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "inference_rules.json")

HTML_TAG_RE = re.compile(r"<[^>]+>")

def load_framework():
    with open(FRAMEWORK_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def load_inference_rules():
    if not os.path.exists(INFERENCE_PATH):
        return {}
    with open(INFERENCE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def infer_skills_from_context(job, rules):
    """Return list of skill names inferred from title, company name, and domain signals.
    These are 'likely' skills not confirmed by keyword match in the description."""
    title = (job.get("title") or "").lower()
    company = (job.get("company") or "").lower()
    desc = (job.get("description") or "").lower()
    source = (job.get("source") or "").lower()
    text = f"{title} {company} {desc} {source}"

    inferred = set()

    for rule in rules.get("title_rules", []):
        patterns = rule["pattern"].lower().split("|")
        if any(p in title for p in patterns):
            inferred.update(rule["skills"])

    for rule in rules.get("domain_rules", []):
        if re.search(rule["pattern"], text, re.I):
            inferred.update(rule["skills"])

    for rule in rules.get("seniority_rules", []):
        if re.search(rule["pattern"], title, re.I):
            inferred.update(rule["skills"])

    # Remove skills that are already confirmed via keyword match
    confirmed = set(job.get("_matched_skills") or [])
    return [s for s in sorted(inferred) if s not in confirmed]


def extract_skills_llm(job, skill_names, client, model="claude-haiku-4-5-20251001"):
    """Extract required and preferred skills using an LLM.
    Returns {"required": [...], "preferred": [...]} with names from skill_names only."""
    text = ((job.get("title") or "") + " " + (job.get("description") or "")).strip()
    if len(text) < 80:
        return {"required": [], "preferred": []}

    skills_list = "\n".join(f"- {n}" for n in skill_names)
    system_prompt = (
        "You are a job description analyser. Given a job title and description, "
        "identify which skills from the provided list are required vs. preferred/nice-to-have. "
        "Return ONLY a JSON object with two arrays: 'required' and 'preferred'. "
        "Use ONLY skill names from the list below. Return no other text.\n\n"
        f"Available skills:\n{skills_list}"
    )
    user_prompt = f"Job title: {job.get('title','')}\n\nDescription:\n{text[:2000]}"

    try:
        response = client.messages.create(
            model=model,
            max_tokens=400,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = response.content[0].text.strip()
        # Strip markdown code fences if present
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S).strip()
        parsed = json.loads(raw)
        valid_names = set(skill_names)
        return {
            "required": [s for s in parsed.get("required", []) if s in valid_names],
            "preferred": [s for s in parsed.get("preferred", []) if s in valid_names],
        }
    except Exception as e:
        return {"required": [], "preferred": [], "_error": str(e)[:80]}


def compute_matched_skills(job, framework_skills):
    """Return list of skill names whose keywords appear in the job title+description."""
    raw = (job.get("title") or "") + " " + (job.get("description") or "")
    text = HTML_TAG_RE.sub(" ", raw).lower()
    matched = []
    for skill in framework_skills:
        for kw in skill.get("keywords", []):
            if kw.lower() in text:
                matched.append(skill["name"])
                break
    return matched

SEED_FILTERS = {
    "keyword": "product",
    "location": "",
    "work_mode": "",
}

LOCATION_KEYWORDS = [
    # Germany
    "germany", "deutschland", "de",
    "munich", "münchen", "muenchen", "berlin", "hamburg", "frankfurt",
    "cologne", "köln", "düsseldorf", "stuttgart", "hannover", "nürnberg",
    "nuremberg", "bremen", "dresden", "leipzig", "dortmund", "essen",
    "bonn", "mannheim", "karlsruhe", "freiburg", "augsburg", "regensburg",
    "heidelberg", "darmstadt", "wiesbaden", "mainz", "aachen", "bielefeld",
    # UK
    "uk", "united kingdom", "london", "manchester", "birmingham", "edinburgh",
    "glasgow", "bristol", "leeds", "cambridge", "oxford", "liverpool",
    # Europe
    "europe", "eu", "emea", "dach",
    "amsterdam", "netherlands", "vienna", "austria", "zurich", "switzerland",
    "paris", "france", "dublin", "ireland", "barcelona", "madrid", "spain",
    "lisbon", "portugal", "copenhagen", "denmark", "stockholm", "sweden",
    "oslo", "norway", "helsinki", "finland", "prague", "czech",
    "warsaw", "poland", "brussels", "belgium", "milan", "italy",
    # Remote / global
    "remote", "worldwide", "global", "anywhere",
]

EXCLUDE_LOCATIONS = [
    "united states", " us ", " usa ", "new york", "san francisco",
    "los angeles", "chicago", "seattle", "boston", "austin", "denver",
    "atlanta", "dallas", "houston", "miami", "portland", "philadelphia",
    "phoenix", "san diego", "san jose", "raleigh", "charlotte",
    "americas only", "us only", "usa only",
]

TITLE_KEYWORDS = [
    "product manager", "product owner", "product analyst",
    "business analyst",
    "produktmanager", "produktowner", "produktanalyst",
    # Broader fallback — catches "product lead", "product director", etc.
    "product", "produkt",
    # Catches "analyst" roles not prefixed with "product" or "business"
    "analyst",
]


def matches_criteria(job):
    title = (job.get("title") or "").lower()
    if not any(kw in title for kw in TITLE_KEYWORDS):
        return False
    location = (job.get("location") or "").lower()
    work_mode = (job.get("work_mode") or "").lower()
    # Exclude US-based roles
    if any(us in f" {location} " for us in EXCLUDE_LOCATIONS):
        return False
    if "remote" in work_mode or "remote" in location:
        return True
    if any(kw in location for kw in LOCATION_KEYWORDS):
        return True
    if not location:
        return True
    return False


def run_seed(enrich_llm=False):
    framework = load_framework()
    framework_skills = framework.get("skills", [])
    skill_names = [s["name"] for s in framework_skills]
    print(f"Loaded skills framework: {len(framework_skills)} skills")

    rules = load_inference_rules()
    print(f"Loaded inference rules: {len(rules.get('title_rules',[]))} title, "
          f"{len(rules.get('domain_rules',[]))} domain, "
          f"{len(rules.get('seniority_rules',[]))} seniority")

    llm_client = None
    if enrich_llm:
        try:
            import anthropic
            llm_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
            print("LLM enrichment enabled (claude-haiku-4-5)")
        except Exception as e:
            print(f"WARNING: LLM enrichment disabled — {e}")
            enrich_llm = False

    # Load existing seed data to merge
    existing_jobs = []
    if os.path.exists(OUTPUT_PATH):
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            old = json.load(f)
            existing_jobs = old.get("jobs", [])
        print(f"Loaded {len(existing_jobs)} existing jobs for merge.")

    # Backfill skill metadata on existing jobs that lack it
    backfilled = 0
    for job in existing_jobs:
        if "_matched_skills" not in job:
            job["_matched_skills"] = compute_matched_skills(job, framework_skills)
            backfilled += 1
        if "_inferred_skills" not in job:
            job["_inferred_skills"] = infer_skills_from_context(job, rules)
            backfilled += 1
        if enrich_llm and "_extracted_skills" not in job:
            job["_extracted_skills"] = extract_skills_llm(job, skill_names, llm_client)
    if backfilled:
        print(f"Backfilled skill metadata on existing jobs.")

    all_jobs = list(existing_jobs)
    errors = []
    seen_urls = {j.get("url") for j in existing_jobs if j.get("url")}

    plugin_files = sorted(f for f in os.listdir(PLUGINS_DIR) if f.endswith((".yaml", ".yml")))
    total = len(plugin_files)

    for idx, fname in enumerate(plugin_files, 1):
        path = os.path.join(PLUGINS_DIR, fname)
        with open(path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)

        name = config.get("name", fname)
        print(f"[{idx}/{total}] {name}...", end=" ", flush=True)

        try:
            jobs = scrape_jobs(config, scrape_filters=SEED_FILTERS)
            matched = []
            for job in jobs:
                if job.get("url") in seen_urls:
                    continue
                if matches_criteria(job):
                    seen_urls.add(job["url"])
                    job["source"] = name
                    job["source_url"] = config.get("base_url", "")
                    job["retrieved_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    job["_matched_skills"] = compute_matched_skills(job, framework_skills)
                    job["_inferred_skills"] = infer_skills_from_context(job, rules)
                    if enrich_llm and llm_client:
                        job["_extracted_skills"] = extract_skills_llm(job, skill_names, llm_client)
                    matched.append(job)
            all_jobs.extend(matched)
            print(f"{len(jobs)} scraped, {len(matched)} matched")
        except Exception as e:
            err = f"{name}: {str(e)[:80]}"
            errors.append(err)
            print(f"ERROR: {str(e)[:60]}")

    seed_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    output = {
        "seeded_at": seed_time,
        "total_jobs": len(all_jobs),
        "sources_queried": total,
        "errors": len(errors),
        "llm_enriched": enrich_llm,
        "criteria": {
            "title_contains": TITLE_KEYWORDS,
            "location": "Germany / UK / Europe / Remote (excl. US)",
        },
        "jobs": all_jobs,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=1)

    print(f"\nSeed complete: {len(all_jobs)} jobs saved to {OUTPUT_PATH}")
    print(f"Seeded at: {seed_time}")
    if errors:
        print(f"Errors ({len(errors)}):")
        for e in errors[:10]:
            print(f"  {e}")

    return output


def is_seed_current():
    if not os.path.exists(OUTPUT_PATH):
        return False
    with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    seeded = data.get("seeded_at", "")
    if not seeded:
        return False
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return seeded.startswith(today)


if __name__ == "__main__":
    enrich_llm = "--enrich-llm" in sys.argv
    if "--check" in sys.argv:
        if is_seed_current():
            print("Seed data is current (today).")
            sys.exit(0)
        else:
            print("Seed data is stale or missing. Running seed...")
            run_seed(enrich_llm=enrich_llm)
    else:
        run_seed(enrich_llm=enrich_llm)

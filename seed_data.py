"""Seed data generator — runs all plugins and saves results as static JSON."""
import os
import sys
import json
import yaml
from datetime import datetime, timezone
from scraper import scrape_jobs

PLUGINS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "data", "jobs.json")

SEED_FILTERS = {
    "keyword": "product",
    "location": "",
    "work_mode": "",
}

LOCATION_KEYWORDS = [
    "munich", "münchen", "muenchen", "germany", "deutschland",
    "berlin", "hamburg", "frankfurt", "cologne", "köln", "düsseldorf",
    "stuttgart", "remote", "eu", "europe", "emea", "dach", "worldwide",
    "global",
]

TITLE_KEYWORDS = ["product", "produkt"]


def matches_criteria(job):
    title = (job.get("title") or "").lower()
    if not any(kw in title for kw in TITLE_KEYWORDS):
        return False
    location = (job.get("location") or "").lower()
    work_mode = (job.get("work_mode") or "").lower()
    if "remote" in work_mode or "remote" in location:
        return True
    if any(kw in location for kw in LOCATION_KEYWORDS):
        return True
    if not location:
        return True
    return False


def run_seed():
    all_jobs = []
    errors = []
    seen_urls = set()

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
        "criteria": {
            "title_contains": TITLE_KEYWORDS,
            "location": "Munich +50km / Germany / EU / Remote",
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
    if "--check" in sys.argv:
        if is_seed_current():
            print("Seed data is current (today).")
            sys.exit(0)
        else:
            print("Seed data is stale or missing. Running seed...")
            run_seed()
    else:
        run_seed()

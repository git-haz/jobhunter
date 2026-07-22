# JobHunter — Change History

## v3.3.0 — Three-Layer Skill Extraction (2026-07-22)

**Problem:** 71% of jobs had stub descriptions (< 200 chars), leaving keyword matching near-useless.
Even rich descriptions missed skills due to narrow exact-phrase matching.

### Option 1 — Full Description Fetching (free)
- **SmartRecruiters**: fetch `jobDescription + qualifications + additionalInformation` from public detail API for each job (Sixt, Check24, Brainlab, Scalable Capital)
- **4dayweek**: scrape full job-page HTML via `scrape_job_detail_html()` per job
- **Celonis**: scrape careers page for full posting text
- **skills_framework.json**: expanded all 37 skills with shorter stems, German variants, tool names, method names (~23 keywords/skill, up from ~15)

### Option 2 — Rule-Based Context Inference (free, zero latency)
- New `docs/data/inference_rules.json`: 13 title rules, 13 domain rules, 2 seniority rules
- `infer_skills_from_context()` in `seed_data.py`: populates `_inferred_skills` per job from role-title pattern, company/domain signals, and seniority modifiers
- Results stored separately from `_matched_skills`; UI labels them "Likely"

### Option 3 — LLM Extraction at Seed Time (opt-in, free at runtime)
- `extract_skills_llm()` calls Anthropic API with cached system prompt (37 skill names)
- Activate with: `python seed_data.py --enrich-llm`
- Stores `_extracted_skills: {required: [...], preferred: [...]}` per job

### UI
- `allJobSkills()` helper unions all three sources for filter counting
- `recomputeSkillsMatch()` counts qualifying skills across all sources
- Job detail modal shows four labelled tiers: **Confirmed** / **Required** / **Nice to have** / **Likely**
- Colour-coded chip borders per tier

### Results
| Metric | Before | After |
|---|---|---|
| Total jobs | 719 | 872 |
| Jobs with any skill signal | 213 (30%) | 826 (94%) |
| Jobs with confirmed keyword match | — | 332 (38%) |
| Jobs with context inference | — | 823 (94%) |

---

## v3.2.0 — StepStone DE Source (2026-07-22)

- New `stepstone` platform scraper: parses `/jobs/{query}/in-{location}` listing pages, extracts job ID, title, company, location, work mode from `article[data-at="job-item"]` cards
- Plugin `plugins/stepstone_de.yaml`: 6 queries × 2 pages on stepstone.de
- Reseed: 719 jobs (was 557); StepStone contributed 44 new matched jobs

---

## v3.1.0 — Precomputed Skill Matching (2026-07-16)

- Each skill in `skills_framework.json` given a `keywords` array (6–12 EN + DE terms)
- `compute_matched_skills()` in `seed_data.py`: scans job title + description at seed time, stores `_matched_skills` list per job
- Seed-time precomputation with browser Set-lookup at runtime (no token cost)
- Keyword design: partial stems ("user stor"), German equivalents, tool names, method names
- Result: at threshold 4.0, matching improved from 12 jobs → 135 jobs (11× improvement)
- Reseed: 557 jobs

---

## v3.0.0 — Skills Assessment Framework (2026-07-15)

- Full **Skills Assessment Framework** page: 37 skills × 6 dimensions (Depth / Breadth / Recency / Impact / Independence / Consistency) × role relevance (BA / PO / PM)
- 0–5 button ratings per dimension per skill; score formula with editable weights
- Role score summary cards with progress bars (BA / PO / PM)
- Collapsible skill categories; open-state preserved across re-renders
- Targeted DOM updates on button click — no full page re-render
- **Scorecard** tab replaced; **Keywords** tab added for old keyword selector
- Feed filter: "Min rated skills" number input; "Most skills matched" sort option
- "Skills match: N" chip on job cards and Kanban
- `jh_skill_scores_v3` and `jh_formula_weights` in localStorage
- Reseed: 532 jobs; plugins updated to search "product" and "analyst" as 2 separate queries

---

## v2.0.0 — Skills Page & Keyword Extraction (2026-07-10)

- Skills self-assessment page: rate 37 skills; scores stored in localStorage
- Keyword extraction: job descriptions scanned for skill-related keywords
- Keyword chips on job cards and in detail modal
- Feed filter: minimum keyword count slider
- Bilingual detection (EN + DE in same posting)

---

## v1.3.1 — Indeed DE Scraper (2026-06-30)

- New `indeed` platform scraper for `de.indeed.com`
- 383 jobs seeded

---

## v1.3.0 — 3-Score Matching (2026-06-28)

- Domain / Must-have / Nice-to-have score breakdown
- Bilingual job detection
- Domain tabs (Engineering / Product / Design / Data / Marketing…)

---

## v1.2.0 — Airline & Travel-Tech Sources (2026-06-27)

- 6 new sources: Ryanair (Workable), Condor (career.aero), Amadeus IT (Workday), GetYourGuide (Greenhouse), Trivago (Greenhouse), Eurowings Digital (Personio)
- New `workable` and `career_aero` platform scrapers
- 87 company-specific plugins total

---

## v1.1.0 — User Scorecard (2026-06-24)

- User-managed skill scorecard stored in localStorage
- Explicit-only matching (no fuzzy)

---

## v1.0.0 — Scorecard-Based Matching (2026-06-22)

- Scorecard system with domain match scoring
- Clickable job cards with detail view modal

---

## v0.9.x — Static GitHub Pages App (2026-06-20 – 2026-06-22)

- v0.9.3: Job title multi-select filter
- v0.9.2: Germany-wide search
- v0.9.1: Retrieved date per job, date range filter
- v0.9.0: Must-have vs nice-to-have requirement classification
- Migrated from Render (Flask) to GitHub Pages (static SPA + pre-seeded JSON)

---

## v0.7.0 — Plugin System & Job Boards (2026-06-18)

- YAML plugin architecture; 82 company plugins
- Arbeitsagentur API scraper
- 4dayweek, Remotive, Himalayas, Arbeitnow aggregators
- Greenhouse, Personio, SmartRecruiters, Workday, Oracle HCM platform scrapers

---

## v0.5.0 — CV Matching & Scoring (2026-06-15)

- CV upload and keyword matching
- Job scoring (0–10) against uploaded CV
- Date filters; job portal links

---

## v0.2.0 — Multi-Platform Scrapers (2026-06-12)

- Workday and Oracle HCM API scrapers
- Pre-scrape keyword/location filters
- Version display in nav

---

## v0.0.0 — Initial Commit (2026-06-10)

- Flask app on Render with basic job scraping and listing

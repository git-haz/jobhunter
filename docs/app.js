const APP_VERSION = "2.0.0";
const VERSION_HISTORY = [
    {v:"2.0.0",d:"2026-07-09",c:["Select your Skills page — toggle keywords from config, see job counts per keyword","Keyword extraction from job descriptions using keywords.json config","Matched keywords shown as chips on every job card","Keyword multiselect filter on feed (must include ALL selected keywords)","Sort by number of keywords matched","Seeding expanded: 4 role types, UK + DE + EU fallback locations, 3-day freshness filter"]},
    {v:"1.3.1",d:"2026-07-07",c:["Indeed DE added as job source","418 jobs total, 3-day freshness filter, UK + EU searches","Seeding: business analyst, product analyst, product owner, product manager"]},
    {v:"1.3.0",d:"2026-07-07",c:["3 separate match scores: Domain %, Must-have %, Nice-to-have %","Bilingual detection: flags jobs requiring German + English","Domain-based tabs from scorecard categories","Expandable match breakdown on every job card"]},
    {v:"1.2.0",d:"2026-06-30",c:["6 new airline & travel-tech sources","New Workable and career.aero scrapers","277+ jobs seeded"]},
    {v:"1.1.0",d:"2026-06-29",c:["User-managed scorecard","Matching only on explicit skill mentions","Scorecard editor with category/skill/rating rows"]},
    {v:"1.0.0",d:"2026-06-29",c:["Scorecard-based matching","Must-haves weighted 70%, nice-to-haves 30%","Job detail modal"]},
    {v:"0.9.3",d:"2026-06-27",c:["Job title multi-select with typeahead"]},
    {v:"0.9.2",d:"2026-06-27",c:["Search expanded to all Germany","Retrieved date filter, 232 jobs"]},
    {v:"0.8.0",d:"2026-06-27",c:["Static GitHub Pages architecture","Pre-seeded job data","All user state in localStorage"]},
];
const STATUSES = ["new","favorite","apply","applied","interview","rejected","withdrawn","hidden"];
const TRACKER_COLS = ["favorite","apply","applied","interview","rejected","withdrawn"];

let JOBS = [];
let SEED_META = {};
let KEYWORD_CONFIG = [];
let currentDetailIdx = null;

// --- STORAGE ---
function loadState(key, def) { try { return JSON.parse(localStorage.getItem("jh_"+key)) || def; } catch { return def; } }
function saveState(key, val) { localStorage.setItem("jh_"+key, JSON.stringify(val)); }
function getUserJobs() { return loadState("user_jobs", {}); }
function setUserJob(url, data) { const uj = getUserJobs(); uj[url] = {...(uj[url]||{}), ...data}; saveState("user_jobs", uj); }
function getScorecard() { return loadState("scorecard", []); }
function saveScorecard(sc) { saveState("scorecard", sc); }
function hasScorecard() { return getScorecard().length > 0; }
function getMySkills() { return new Set(loadState("my_skills", [])); }
function saveMySkills(skills) { saveState("my_skills", [...skills]); }

// --- KEYWORD MATCHING ---
function computeKeywords(j) {
    if (!KEYWORD_CONFIG.length) return [];
    const text = ((j.title || "") + " " + (j.description || "")).toLowerCase();
    return KEYWORD_CONFIG.filter(kw => text.includes(kw.toLowerCase()));
}

// --- SCORECARD MATCHING ---
const MUST_HEADERS = /(?:must.?have|required|requirements|what you.?(?:ll )?need|what we.?(?:re )?looking for|you bring|qualifications|essential|anforderungen|voraussetzungen|was du mitbringst|das bringst du mit|dein profil|ihr profil|what you.?(?:ll )?bring|your profile|key requirements)/i;
const NICE_HEADERS = /(?:nice.?to.?have|bonus|preferred|desirable|optional|ideally|additional|plus|advantageous|beneficial|w[üu]nschenswert|von vorteil|idealerweise|zus[äa]tzlich|what.?s a plus|it.?s a bonus|extra points|good to have)/i;
const NICE_CUES = /(?:nice to have|bonus|preferred|ideally|preferably|desirable|a plus|an advantage|not required|optional|beneficial|von vorteil|w[üu]nschenswert|idealerweise|gerne gesehen|nicht zwingend)/i;
const GERMAN_LANG = /\b(german|deutsch(?:e?|kenntnisse)?)\b/i;
const ENGLISH_LANG = /\b(english|englisch(?:e?|kenntnisse)?)\b/i;

function classifyRequirements(desc) {
    if (!desc) return { mustText: "", niceText: "" };
    const lines = desc.replace(/<[^>]+>/g, "\n").split("\n").filter(l => l.trim());
    let current = "must", sectionFound = false;
    const mustLines = [], niceLines = [];
    for (const line of lines) {
        const s = line.trim();
        if (NICE_HEADERS.test(s)) { current = "nice"; sectionFound = true; continue; }
        if (MUST_HEADERS.test(s)) { current = "must"; sectionFound = true; continue; }
        if (current === "must") mustLines.push(s); else niceLines.push(s);
    }
    if (sectionFound) return { mustText: mustLines.join(" "), niceText: niceLines.join(" ") };
    const ml = [], nl = [];
    for (const line of lines) {
        const s = line.trim();
        if (NICE_CUES.test(s)) nl.push(s); else ml.push(s);
    }
    return { mustText: ml.join(" "), niceText: nl.join(" ") };
}

function findScorecardMatches(text, scorecard) {
    if (!text || !scorecard.length) return [];
    const lower = text.toLowerCase().replace(/<[^>]+>/g, " ");
    const found = [];
    const sorted = [...scorecard].sort((a, b) => b.skill.length - a.skill.length);
    const used = new Set();
    for (const entry of sorted) {
        const sk = entry.skill.toLowerCase();
        if (sk && lower.includes(sk) && !used.has(sk)) {
            used.add(sk);
            found.push({ skill: entry.skill, category: entry.category || "", rating: entry.rating, weight: entry.rating / 5 });
        }
    }
    return found;
}

function computeDomainMatch(fullText, scorecard) {
    const lower = (fullText || "").toLowerCase().replace(/<[^>]+>/g, " ");
    const domainMap = {};
    for (const entry of scorecard) {
        const cat = entry.category || "Other";
        if (!domainMap[cat]) domainMap[cat] = [];
        domainMap[cat].push(entry);
    }
    let totalWeight = 0, matchedWeight = 0;
    const matchedDomains = [];
    for (const [name, skills] of Object.entries(domainMap)) {
        const avgW = skills.reduce((s, e) => s + e.rating / 5, 0) / skills.length;
        totalWeight += avgW;
        const sorted = [...skills].sort((a, b) => b.skill.length - a.skill.length);
        const matched = [];
        const used = new Set();
        for (const e of sorted) {
            const sk = e.skill.toLowerCase();
            if (sk && lower.includes(sk) && !used.has(sk)) { used.add(sk); matched.push(e); }
        }
        if (matched.length) {
            matchedWeight += avgW;
            matchedDomains.push({ name, skills: matched });
        }
    }
    const score = totalWeight > 0 ? Math.round(matchedWeight / totalWeight * 100) : 0;
    return { score, matchedDomains };
}

function detailedMatch(description) {
    const sc = getScorecard();
    const result = {
        domainScore: 0, mustScore: 0, niceScore: 0,
        mustTotal: 0, niceTotal: 0,
        matchedDomains: [],
        matchedMusts: [], matchedNices: [],
        missingSkills: [],
        bilingual: false,
    };
    const plain = (description || "").replace(/<[^>]+>/g, " ");
    result.bilingual = GERMAN_LANG.test(plain) && ENGLISH_LANG.test(plain);
    if (!description || !sc.length) return result;

    const { mustText, niceText } = classifyRequirements(description);
    const { score: domScore, matchedDomains } = computeDomainMatch(description, sc);
    result.domainScore = domScore;
    result.matchedDomains = matchedDomains;

    const mustSkills = findScorecardMatches(mustText, sc);
    const niceSkills = findScorecardMatches(niceText, sc);
    result.matchedMusts = mustSkills;
    result.matchedNices = niceSkills;
    result.mustTotal = mustSkills.length;
    result.niceTotal = niceSkills.length;

    if (mustSkills.length) result.mustScore = Math.round(mustSkills.reduce((s, x) => s + x.weight, 0) / mustSkills.length * 100);
    if (niceSkills.length) result.niceScore = Math.round(niceSkills.reduce((s, x) => s + x.weight, 0) / niceSkills.length * 100);

    const fullLower = (description || "").toLowerCase().replace(/<[^>]+>/g, " ");
    const alreadyMatched = new Set([...mustSkills, ...niceSkills].map(s => s.skill.toLowerCase()));
    result.missingSkills = sc.filter(e => {
        const sk = e.skill.toLowerCase();
        return sk && !alreadyMatched.has(sk) && !fullLower.includes(sk);
    });

    return result;
}

function recomputeScores() {
    for (const j of JOBS) {
        const dm = detailedMatch(j.description || "");
        j._dm = dm;
        j._domainScore = dm.domainScore;
        j._mustScore = dm.mustScore;
        j._niceScore = dm.niceScore;
        j._bilingual = dm.bilingual;
        j._matchedKw = computeKeywords(j);
        j._kwCount = j._matchedKw.length;
    }
}

// --- SECTOR (fallback when no scorecard loaded) ---
const SECTOR_MAP = {engineering:["engineering","software","development","backend","frontend","fullstack","devops","infrastructure"],product:["product","product management"],design:["design","ux","ui","creative"],data:["data","analytics","machine learning","ai","artificial intelligence"],marketing:["marketing","growth","content","brand"],sales:["sales","business development","account","revenue"],operations:["operations","supply chain","logistics","project management"],finance:["finance","accounting","tax","treasury"],hr:["human resources","hr","people","talent","recruiting"],"legal & compliance":["legal","compliance","regulatory","risk"],customer:["customer","support","service","success","client"],it:["it","information technology","security","infosec"]};
function getSector(dept) {
    if (!dept) return "Other";
    const l = dept.toLowerCase();
    for (const [s,kws] of Object.entries(SECTOR_MAP)) { for (const k of kws) if (l.includes(k)) return s.charAt(0).toUpperCase()+s.slice(1); }
    return "Other";
}

function getJobDomains(j) { return (j._dm?.matchedDomains || []).map(d => d.name); }
function scoreCls(v) { return v >= 60 ? "high" : v >= 30 ? "mid" : "low"; }
function faviconUrl(baseUrl) { try { return `https://www.google.com/s2/favicons?domain=${new URL(baseUrl).hostname}&sz=64`; } catch { return ""; } }

// --- INIT ---
async function init() {
    document.getElementById("version-display").textContent = `v${APP_VERSION}`;
    let vh = "";
    for (const v of VERSION_HISTORY) { vh += `<div class="version-entry"><h4>v${v.v} <small>(${v.d})</small></h4><ul>${v.c.map(c=>`<li>${c}</li>`).join("")}</ul></div>`; }
    document.getElementById("version-history").innerHTML = vh;

    const [jobsResp, kwResp] = await Promise.all([
        fetch("data/jobs.json"),
        fetch("data/keywords.json"),
    ]);
    const data = await jobsResp.json();
    const kwData = await kwResp.json();
    JOBS = data.jobs || [];
    SEED_META = data;
    KEYWORD_CONFIG = kwData.keywords || [];

    document.getElementById("seed-info").innerHTML = `<small>Data seeded: <strong>${data.seeded_at?.slice(0,16).replace("T"," ")||"?"} UTC</strong> · ${data.total_jobs} jobs from ${data.sources_queried} sources</small>`;

    recomputeScores();
    buildTitleOptions();
    document.getElementById("cv-banner").style.display = hasScorecard() ? "none" : "flex";

    initTitleFilter();
    initKeywordFilter();
    buildStatusSelect(document.getElementById("detail-status"));

    // Show Skills page on first visit; otherwise go straight to feed
    if (localStorage.getItem("jh_my_skills") === null) {
        showView("skills");
    } else {
        showView("feed");
        applyFilters();
    }
}

function buildStatusSelect(sel) {
    sel.innerHTML = STATUSES.filter(s=>s!=="new"&&s!=="hidden").map(s=>`<option value="${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join("") + `<option value="new">New (reset)</option>`;
}

// --- VIEWS ---
function showView(name) {
    ["feed","tracker","scorecard","skills"].forEach(v => {
        document.getElementById("view-"+v).style.display = v===name?"":"none";
        const link = document.querySelector(`.nav-link[data-view="${v}"]`);
        if (link) link.classList.toggle("active", v===name);
    });
    if (name === "tracker") renderKanban();
    if (name === "scorecard") renderScorecard();
    if (name === "skills") renderSkillsPage();
    if (name === "feed") applyFilters();
}

// --- SKILLS PAGE ---
let mySkillsState = new Set();

function renderSkillsPage() {
    mySkillsState = getMySkills();
    const kwCounts = {};
    for (const kw of KEYWORD_CONFIG) {
        kwCounts[kw] = JOBS.filter(j => (j._matchedKw || []).includes(kw)).length;
    }
    const grid = document.getElementById("skills-grid");
    grid.innerHTML = KEYWORD_CONFIG.map(kw =>
        `<button class="skill-chip ${mySkillsState.has(kw) ? "active" : ""}" onclick="toggleMySkill('${esc(kw)}')">${esc(kw)}<span class="skill-chip-count">${kwCounts[kw]}</span></button>`
    ).join("");
}

function toggleMySkill(kw) {
    if (mySkillsState.has(kw)) mySkillsState.delete(kw);
    else mySkillsState.add(kw);
    document.querySelectorAll(".skill-chip").forEach(btn => {
        const label = btn.childNodes[0]?.textContent?.trim();
        if (label === kw) btn.classList.toggle("active", mySkillsState.has(kw));
    });
}

function clearMySkills() {
    mySkillsState.clear();
    document.querySelectorAll(".skill-chip").forEach(btn => btn.classList.remove("active"));
}

function saveAndGoFeed() {
    saveMySkills(mySkillsState);
    // Pre-populate keyword filter with selected skills
    selectedKeywords = new Set(mySkillsState);
    renderKeywordChips();
    showView("feed");
}

// --- TITLE FILTER ---
function buildTitleOptions() {
    const counts = {};
    for (const j of JOBS) {
        const clean = cleanTitle(j.title);
        j._cleanTitle = clean;
        const key = clean.toLowerCase();
        if (!counts[key]) counts[key] = { label: clean, count: 0 };
        counts[key].count++;
    }
    TITLE_OPTIONS = Object.values(counts)
        .filter(t => t.count >= 2)
        .sort((a, b) => b.count - a.count);
}

function cleanTitle(raw) {
    let t = raw;
    t = t.replace(/\s*\(?\s*[mwfd]\s*[\/\|]\s*[mwfd]\s*(?:[\/\|]\s*[mwfd])?\s*\)?\s*/gi, " ");
    t = t.replace(/\s*\(?\s*all\s+genders?\s*\)?\s*/gi, " ");
    t = t.replace(/\s*\(?\s*gn\s*\)?\s*/gi, " ");
    t = t.replace(/\*\s*in\b/g, "");
    t = t.replace(/\s*[|@—–]\s*.{3,}$/, "");
    t = t.replace(/\s+(?:bei|at|für|for)\s+[A-Z].{2,}$/, "");
    t = t.replace(/^\s*\((?:Senior|Junior|Lead|Staff|Principal|Head of)\)\s*/i, "");
    t = t.replace(/^\s*(?:Senior|Junior|Lead|Principal|Staff|Head of|Sr\.|Jr\.)\s+/i, "");
    t = t.replace(/\s{2,}/g, " ").replace(/\s*[-–—]\s*$/, "").trim();
    return t;
}

let TITLE_OPTIONS = [];
let selectedTitles = new Set();

function initTitleFilter() {
    const chips = document.getElementById("title-chips");
    const input = document.getElementById("title-search");
    const dropdown = document.getElementById("title-dropdown");

    function render() {
        chips.innerHTML = "";
        selectedTitles.forEach(t => {
            const chip = document.createElement("span");
            chip.className = "ms-chip";
            chip.innerHTML = `${esc(t)} <span class="ms-chip-x" data-t="${esc(t)}">&times;</span>`;
            chips.appendChild(chip);
        });
        chips.querySelectorAll(".ms-chip-x").forEach(x => {
            x.onclick = () => { selectedTitles.delete(x.dataset.t); render(); applyFilters(); };
        });
    }

    function showDropdown(filter) {
        const q = filter.toLowerCase();
        const matches = TITLE_OPTIONS.filter(t => !selectedTitles.has(t.label) && t.label.toLowerCase().includes(q));
        if (!matches.length && !q) { dropdown.style.display = "none"; return; }
        let html = matches.slice(0, 15).map(t =>
            `<div class="ms-option" data-t="${esc(t.label)}">${esc(t.label)} <small>(${t.count})</small></div>`
        ).join("");
        if (q && !matches.some(t => t.label.toLowerCase() === q)) {
            html += `<div class="ms-option ms-custom" data-t="${esc(filter.trim())}">+ "${esc(filter.trim())}"</div>`;
        }
        dropdown.innerHTML = html;
        dropdown.style.display = html ? "block" : "none";
        dropdown.querySelectorAll(".ms-option").forEach(opt => {
            opt.onmousedown = (e) => {
                e.preventDefault();
                selectedTitles.add(opt.dataset.t);
                input.value = "";
                dropdown.style.display = "none";
                render();
                applyFilters();
            };
        });
    }

    input.addEventListener("input", () => showDropdown(input.value));
    input.addEventListener("focus", () => showDropdown(input.value));
    input.addEventListener("blur", () => setTimeout(() => dropdown.style.display = "none", 150));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
            e.preventDefault();
            selectedTitles.add(input.value.trim());
            input.value = "";
            dropdown.style.display = "none";
            render();
            applyFilters();
        }
        if (e.key === "Backspace" && !input.value && selectedTitles.size) {
            const last = Array.from(selectedTitles).pop();
            selectedTitles.delete(last);
            render();
            applyFilters();
        }
    });

    render();
}

// --- KEYWORD FILTER ---
let selectedKeywords = new Set();
let kwDropdownOpen = false;

function initKeywordFilter() {
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#kw-filter")) closeKwDropdown();
    });
}

function toggleKwDropdown() {
    if (kwDropdownOpen) closeKwDropdown();
    else openKwDropdown();
}

function openKwDropdown() {
    kwDropdownOpen = true;
    const dropdown = document.getElementById("kw-dropdown");
    dropdown.innerHTML = KEYWORD_CONFIG.map(kw => {
        const checked = selectedKeywords.has(kw) ? "checked" : "";
        const count = JOBS.filter(j => (j._matchedKw||[]).includes(kw)).length;
        return `<label class="kw-option"><input type="checkbox" ${checked} onchange="toggleKeyword('${esc(kw)}')">${esc(kw)} <small>(${count})</small></label>`;
    }).join("");
    dropdown.style.display = "block";
}

function closeKwDropdown() {
    kwDropdownOpen = false;
    document.getElementById("kw-dropdown").style.display = "none";
}

function toggleKeyword(kw) {
    if (selectedKeywords.has(kw)) selectedKeywords.delete(kw);
    else selectedKeywords.add(kw);
    renderKeywordChips();
    applyFilters();
}

function renderKeywordChips() {
    const chips = document.getElementById("kw-chips");
    chips.innerHTML = [...selectedKeywords].map(kw =>
        `<span class="ms-chip ms-chip-kw">${esc(kw)}<span class="ms-chip-x" data-kw="${esc(kw)}">&times;</span></span>`
    ).join("");
    chips.querySelectorAll(".ms-chip-x").forEach(x => {
        x.onclick = (e) => {
            e.stopPropagation();
            selectedKeywords.delete(x.dataset.kw);
            renderKeywordChips();
            // Uncheck in dropdown if open
            const dropdown = document.getElementById("kw-dropdown");
            const cb = dropdown.querySelector(`input[onchange*="${esc(x.dataset.kw)}"]`);
            if (cb) cb.checked = false;
            applyFilters();
        };
    });
    document.getElementById("kw-toggle").textContent = selectedKeywords.size
        ? `+ More keywords ▾`
        : `+ Add keyword filter ▾`;
}

// --- FILTERING ---
function parseExclude(raw) {
    if (!raw) return [];
    const matches = [...raw.matchAll(/"([^"]+)"|([^,]+)/g)];
    return matches.map(m => (m[1]||m[2]).trim().toLowerCase()).filter(Boolean);
}

function applyFilters() {
    const titleFilters = Array.from(selectedTitles).map(t => t.toLowerCase());
    const loc = document.getElementById("f-location").value.toLowerCase().trim();
    const wm = document.getElementById("f-workmode").value;
    const company = document.getElementById("f-company").value.toLowerCase().trim();
    const level = document.getElementById("f-level").value;
    const dept = document.getElementById("f-dept").value.toLowerCase().trim();
    const status = document.getElementById("f-status").value;
    const bilingualFilter = document.getElementById("f-bilingual").value;
    const excludeTerms = parseExclude(document.getElementById("f-exclude").value);
    const dateFrom = document.getElementById("f-date-from").value;
    const dateTo = document.getElementById("f-date-to").value;
    const sort = document.getElementById("f-sort").value;

    const uj = getUserJobs();
    let filtered = JOBS.filter(j => {
        const jStatus = uj[j.url]?.status || "new";
        if (titleFilters.length && !titleFilters.some(t => (j._cleanTitle||j.title).toLowerCase().includes(t))) return false;
        if (loc && !(j.location||"").toLowerCase().includes(loc)) return false;
        if (wm && !(j.work_mode||"").toLowerCase().includes(wm)) return false;
        if (company && !(j.source||"").toLowerCase().includes(company)) return false;
        if (level && !(j.seniority||"").toLowerCase().includes(level)) return false;
        if (dept && !(j.department||"").toLowerCase().includes(dept)) return false;
        if (status) { if (jStatus !== status) return false; }
        else { if (jStatus === "hidden") return false; }
        if (bilingualFilter === "yes" && !j._bilingual) return false;
        if (bilingualFilter === "no" && j._bilingual) return false;
        if (selectedKeywords.size) {
            const jkw = new Set((j._matchedKw||[]).map(k => k.toLowerCase()));
            if (![...selectedKeywords].every(k => jkw.has(k.toLowerCase()))) return false;
        }
        if (excludeTerms.length) {
            const searchable = `${j.title} ${j.description||""} ${j.department||""}`.toLowerCase();
            if (excludeTerms.some(t => searchable.includes(t))) return false;
        }
        if (dateFrom) { const d = (j.retrieved_at||j.first_seen||"").slice(0,10); if (d < dateFrom) return false; }
        if (dateTo) { const d = (j.retrieved_at||j.first_seen||"").slice(0,10); if (d > dateTo) return false; }
        return true;
    });

    if (sort === "date_asc") filtered.sort((a,b) => (a.first_seen||"").localeCompare(b.first_seen||""));
    else if (sort === "company_asc") filtered.sort((a,b) => (a.source||"").localeCompare(b.source||""));
    else if (sort === "kw_desc") filtered.sort((a,b) => (b._kwCount||0)-(a._kwCount||0));
    else if (sort === "domain_desc") filtered.sort((a,b) => (b._domainScore||0)-(a._domainScore||0));
    else if (sort === "must_desc") filtered.sort((a,b) => (b._mustScore||0)-(a._mustScore||0));
    else if (sort === "nice_desc") filtered.sort((a,b) => (b._niceScore||0)-(a._niceScore||0));
    else filtered.reverse();

    renderSectorTabs(filtered);
    renderJobs(filtered);
}

function clearFilters() {
    ["f-location","f-company","f-dept","f-exclude","f-date-from","f-date-to"].forEach(id => document.getElementById(id).value = "");
    selectedTitles.clear();
    document.getElementById("title-chips").innerHTML = "";
    document.getElementById("title-search").value = "";
    ["f-workmode","f-level","f-status","f-bilingual"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("f-sort").value = "date_desc";
    selectedKeywords.clear();
    renderKeywordChips();
    applyFilters();
}

// --- DOMAIN / SECTOR TABS ---
let currentSector = "all";
function renderSectorTabs(jobs) {
    const sc = getScorecard();
    let html = "";
    if (!sc.length) {
        const sectors = {};
        for (const j of jobs) { const s = getSector(j.department); sectors[s] = (sectors[s]||0)+1; }
        const names = Object.keys(sectors).sort();
        html = `<button class="tab-btn ${currentSector==="all"?"active":""}" onclick="filterSector('all')">All (${jobs.length})</button>`;
        for (const s of names) html += `<button class="tab-btn ${currentSector===s?"active":""}" onclick="filterSector('${s}')">${s} (${sectors[s]})</button>`;
    } else {
        const domainCounts = {};
        let unknownCount = 0;
        for (const j of jobs) {
            const domains = getJobDomains(j);
            if (!domains.length) { unknownCount++; }
            else { for (const d of domains) { domainCounts[d] = (domainCounts[d]||0)+1; } }
        }
        const names = Object.keys(domainCounts).sort();
        html = `<button class="tab-btn ${currentSector==="all"?"active":""}" onclick="filterSector('all')">All (${jobs.length})</button>`;
        for (const s of names) html += `<button class="tab-btn ${currentSector===s?"active":""}" onclick="filterSector('${esc(s)}')">${esc(s)} (${domainCounts[s]})</button>`;
        if (unknownCount) html += `<button class="tab-btn ${currentSector==="Unknown"?"active":""}" onclick="filterSector('Unknown')">Unknown (${unknownCount})</button>`;
    }
    document.getElementById("sector-tabs").innerHTML = html;
}

function filterSector(s) { currentSector = s; applyFilters(); }

// --- RENDER JOBS ---
function renderJobs(jobs) {
    const uj = getUserJobs();
    const sc = getScorecard();
    const list = document.getElementById("job-list");
    let html = "";
    let count = 0;
    for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        if (currentSector !== "all") {
            if (sc.length) {
                const domains = getJobDomains(j);
                if (currentSector === "Unknown" && domains.length) continue;
                if (currentSector !== "Unknown" && !domains.includes(currentSector)) continue;
            } else {
                if (getSector(j.department) !== currentSector) continue;
            }
        }
        const st = uj[j.url]?.status || "new";
        const fav = faviconUrl(j.source_url||"");
        const initial = (j.source||"?")[0];
        const dm = j._dm;
        count++;

        // Score badges row
        let scoresHtml = "";
        if (dm) {
            const badges = [];
            if (sc.length) {
                if (dm.domainScore) badges.push(`<span class="match-badge match-${scoreCls(dm.domainScore)}" title="Domain match">D ${dm.domainScore}%</span>`);
                if (dm.mustScore) badges.push(`<span class="match-badge match-${scoreCls(dm.mustScore)}" title="Must-have match">M ${dm.mustScore}%</span>`);
                if (dm.niceScore) badges.push(`<span class="match-badge match-${scoreCls(dm.niceScore)}" title="Nice-to-have match">N ${dm.niceScore}%</span>`);
            }
            if (dm.bilingual) badges.push(`<span class="tag tag-bilingual">🌐 Bilingual</span>`);
            if (badges.length) scoresHtml += `<div class="score-row">${badges.join("")}</div>`;

            if (sc.length && (dm.matchedDomains.length || dm.matchedMusts.length || dm.matchedNices.length)) {
                let bd = `<details class="match-expand"><summary>Match breakdown</summary><div class="match-breakdown-inner">`;
                if (dm.matchedDomains.length) bd += `<div class="mb-section"><strong>Domains:</strong> ${dm.matchedDomains.map(d => `<span class="kw-match">${esc(d.name)}</span>`).join(" ")}</div>`;
                if (dm.matchedMusts.length) bd += `<div class="mb-section"><strong>Must-haves:</strong> ${dm.matchedMusts.map(s => `<span class="kw-match">${esc(s.skill)} <small>${s.rating}/5</small></span>`).join(" ")}</div>`;
                if (dm.matchedNices.length) bd += `<div class="mb-section"><strong>Nice-to-haves:</strong> ${dm.matchedNices.map(s => `<span class="kw-match">${esc(s.skill)} <small>${s.rating}/5</small></span>`).join(" ")}</div>`;
                if (dm.missingSkills.length) bd += `<div class="mb-section"><em class="mb-missing-label">Not mentioned (${dm.missingSkills.length} of your skills):</em> ${dm.missingSkills.map(s => `<span class="kw-miss">${esc(s.skill)}</span>`).join(" ")}</div>`;
                bd += `</div></details>`;
                scoresHtml += bd;
            }
        }

        // Keyword chips row
        let kwHtml = "";
        if (j._matchedKw && j._matchedKw.length) {
            const chips = j._matchedKw.map(kw => {
                const isSelected = selectedKeywords.has(kw);
                return `<span class="tag tag-kw ${isSelected ? "tag-kw-active" : ""}">${esc(kw)}</span>`;
            }).join("");
            kwHtml = `<div class="kw-chips-row">${chips}</div>`;
        }

        html += `<article class="job-card" data-url="${esc(j.url)}">
            <div class="job-card-body" onclick="openDetail(${JOBS.indexOf(j)})" style="cursor:pointer">
                <div class="job-logo"><img src="${fav}" width="48" height="48" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22><rect width=%2248%22 height=%2248%22 rx=%228%22 fill=%22%23667%22/><text x=%2224%22 y=%2232%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2220%22>${initial}</text></svg>'"></div>
                <div class="job-info">
                    <h3>${esc(j.title)}</h3>
                    <div class="job-company">${esc(j.source)}</div>
                    <div class="job-tags">
                        ${j.location?`<span class="tag tag-location">${esc(j.location)}</span>`:""}
                        ${j.work_mode?`<span class="tag tag-workmode">${esc(j.work_mode)}</span>`:""}
                        ${j.employment_type?`<span class="tag tag-type">${esc(j.employment_type)}</span>`:""}
                        ${j.department?`<span class="tag tag-dept">${esc(j.department)}</span>`:""}
                        ${j.seniority?`<span class="tag tag-seniority">${esc(j.seniority)}</span>`:""}
                        ${j.salary_text?`<span class="tag tag-salary">${esc(j.salary_text)}</span>`:""}
                    </div>
                    ${j.description?`<div class="job-description">${sanitizeHtml((j.description||"").slice(0,500))}</div>`:""}
                    ${scoresHtml}
                    ${kwHtml}
                    <div class="job-footer">
                        <small class="job-date" title="Retrieved: ${(j.retrieved_at||"").slice(0,16).replace("T"," ")}">${(j.retrieved_at||j.first_seen||"").slice(0,10)}</small>
                        <small class="status-label status-${st}">${st}</small>
                    </div>
                </div>
            </div>
            <div class="job-actions">
                <button class="outline small ${st==="favorite"?"active":""}" onclick="toggleFav('${esc(j.url)}')">★</button>
                <button class="outline small" onclick="setJobStatus('${esc(j.url)}','hidden')">✕</button>
                <button class="outline small" onclick="openDetail(${JOBS.indexOf(j)})">✎</button>
            </div>
        </article>`;
    }
    list.innerHTML = html || "<p>No jobs match your filters.</p>";
    document.getElementById("job-count").textContent = `${count} job${count!==1?"s":""} found`;
}

function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function sanitizeHtml(raw) {
    if (!raw) return "";
    const ALLOWED = new Set(["p","ul","ol","li","strong","em","b","i","br","h2","h3","h4","span","a","div"]);
    const tmp = document.createElement("div");
    tmp.innerHTML = raw;
    function clean(node) {
        const children = Array.from(node.childNodes);
        for (const child of children) {
            if (child.nodeType === 3) continue;
            if (child.nodeType !== 1) { child.remove(); continue; }
            const tag = child.tagName.toLowerCase();
            if (!ALLOWED.has(tag)) {
                while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
                child.remove();
                continue;
            }
            const attrs = Array.from(child.attributes);
            for (const attr of attrs) {
                if (tag === "a" && attr.name === "href" && (attr.value.startsWith("http") || attr.value.startsWith("/"))) continue;
                child.removeAttribute(attr.name);
            }
            if (tag === "a") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener"); }
            clean(child);
        }
    }
    clean(tmp);
    return tmp.innerHTML;
}

// --- JOB ACTIONS ---
function toggleFav(url) {
    const uj = getUserJobs();
    const cur = uj[url]?.status || "new";
    setJobStatus(url, cur === "favorite" ? "new" : "favorite");
}

function setJobStatus(url, status) {
    setUserJob(url, {status});
    applyFilters();
}

// --- DETAIL MODAL ---
function openDetail(idx) {
    currentDetailIdx = idx;
    const j = JOBS[idx];
    const uj = getUserJobs();
    const st = uj[j.url]?.status || "new";
    const notes = uj[j.url]?.notes || "";

    document.getElementById("detail-title").textContent = j.title;
    document.getElementById("detail-link").href = j.url;
    document.getElementById("detail-status").value = st === "new" || st === "hidden" ? "apply" : st;
    document.getElementById("detail-notes").value = notes;

    let meta = `<strong>${esc(j.source)}</strong>`;
    if (j.location) meta += ` · ${esc(j.location)}`;
    if (j.work_mode) meta += ` · <span class="tag tag-workmode">${esc(j.work_mode)}</span>`;
    if (j.employment_type) meta += ` · <span class="tag tag-type">${esc(j.employment_type)}</span>`;
    if (j.department) meta += ` · <span class="tag tag-dept">${esc(j.department)}</span>`;
    if (j.salary_text) meta += ` · <span class="tag tag-salary">${esc(j.salary_text)}</span>`;
    document.getElementById("detail-meta").innerHTML = meta;

    const dm = j._dm || detailedMatch(j.description || "");
    const sc = getScorecard();
    let kwHtml = "";

    // Keyword chips in modal
    if (j._matchedKw && j._matchedKw.length) {
        const chips = j._matchedKw.map(kw => {
            const isSelected = selectedKeywords.has(kw);
            return `<span class="tag tag-kw ${isSelected ? "tag-kw-active" : ""}">${esc(kw)}</span>`;
        }).join(" ");
        kwHtml += `<div class="detail-kw-row"><strong>Keywords matched:</strong> <span class="kw-chips-row" style="display:inline-flex">${chips}</span></div>`;
    }

    if (dm.bilingual) {
        kwHtml += `<div class="detail-bilingual"><span class="tag tag-bilingual">🌐 Requires German &amp; English</span></div>`;
    }

    if (sc.length) {
        kwHtml += `<div class="detail-scores">
            <span class="match-badge match-${scoreCls(dm.domainScore)}" title="Domain match">Domain ${dm.domainScore}%</span>
            <span class="match-badge match-${scoreCls(dm.mustScore)}" title="Must-have match">Must-haves ${dm.mustScore}%</span>
            <span class="match-badge match-${scoreCls(dm.niceScore)}" title="Nice-to-have match">Nice-to-haves ${dm.niceScore}%</span>
        </div>`;

        if (dm.matchedDomains.length) {
            kwHtml += `<details class="match-section" open><summary><strong>Domain match</strong> — ${dm.matchedDomains.length} domain${dm.matchedDomains.length>1?"s":""}</summary><div class="mb-skills">`;
            for (const d of dm.matchedDomains) kwHtml += `<span class="kw-match">${esc(d.name)} <small>${d.skills.length} skill${d.skills.length>1?"s":""}</small></span>`;
            kwHtml += `</div></details>`;
        }

        if (dm.matchedMusts.length) {
            kwHtml += `<details class="match-section" open><summary><strong>Must-haves matched</strong> — ${dm.matchedMusts.length} of your skills</summary><div class="mb-skills">`;
            for (const s of dm.matchedMusts) kwHtml += `<span class="kw-match">${esc(s.skill)} <small>${s.rating}/5</small></span>`;
            kwHtml += `</div></details>`;
        }

        if (dm.matchedNices.length) {
            kwHtml += `<details class="match-section"><summary><strong>Nice-to-haves matched</strong> — ${dm.matchedNices.length} of your skills</summary><div class="mb-skills">`;
            for (const s of dm.matchedNices) kwHtml += `<span class="kw-match">${esc(s.skill)} <small>${s.rating}/5</small></span>`;
            kwHtml += `</div></details>`;
        }

        if (dm.missingSkills.length) {
            kwHtml += `<details class="match-section"><summary>Your skills not mentioned — ${dm.missingSkills.length}</summary><div class="mb-skills">`;
            for (const s of dm.missingSkills) kwHtml += `<span class="kw-miss">${esc(s.skill)}</span>`;
            kwHtml += `</div></details>`;
        }
    }

    document.getElementById("detail-keywords").innerHTML = kwHtml;
    document.getElementById("detail-description").innerHTML = sanitizeHtml(j.description) || "No description available.";
    document.getElementById("detail-modal").showModal();
}

function changeDetailStatus() {
    if (currentDetailIdx === null) return;
    const j = JOBS[currentDetailIdx];
    const status = document.getElementById("detail-status").value;
    const notes = document.getElementById("detail-notes").value;
    setUserJob(j.url, {status, notes});
}

function saveDetailNotes() {
    if (currentDetailIdx === null) return;
    const j = JOBS[currentDetailIdx];
    const notes = document.getElementById("detail-notes").value;
    setUserJob(j.url, {notes});
}

// --- KANBAN ---
function renderKanban() {
    const uj = getUserJobs();
    const sc = getScorecard();
    const cols = {};
    for (const c of TRACKER_COLS) cols[c] = [];
    for (const j of JOBS) {
        const st = uj[j.url]?.status;
        if (st && cols[st]) cols[st].push(j);
    }

    let html = "";
    for (const col of TRACKER_COLS) {
        html += `<div class="kanban-col"><div class="kanban-col-header"><span class="kanban-col-title status-${col}">${col.charAt(0).toUpperCase()+col.slice(1)}</span><span class="kanban-col-count">${cols[col].length}</span></div><div class="kanban-cards">`;
        for (const j of cols[col]) {
            const dm = j._dm;
            let scores = "";
            if (sc.length && dm) {
                if (dm.domainScore) scores += `<span class="match-badge match-${scoreCls(dm.domainScore)}">D${dm.domainScore}%</span> `;
                if (dm.mustScore) scores += `<span class="match-badge match-${scoreCls(dm.mustScore)}">M${dm.mustScore}%</span> `;
                if (dm.niceScore) scores += `<span class="match-badge match-${scoreCls(dm.niceScore)}">N${dm.niceScore}%</span>`;
            }
            const kwChips = (j._matchedKw||[]).slice(0,3).map(kw => `<span class="tag tag-kw" style="font-size:0.65rem;padding:0.05rem 0.3rem">${esc(kw)}</span>`).join("");
            html += `<div class="kanban-card" onclick="openDetail(${JOBS.indexOf(j)})">
                <div class="kc-title">${esc(j.title.slice(0,40))}${j.title.length>40?"...":""}</div>
                <div class="kc-company">${esc(j.source)}</div>
                <div class="kc-meta">
                    ${j.location?`<span>${esc(j.location.slice(0,15))}${j.location.length>15?"…":""}</span>`:""}
                    ${j.work_mode?`<span class="tag tag-workmode">${esc(j.work_mode)}</span>`:""}
                </div>
                ${scores?`<div class="kc-scores">${scores}</div>`:""}
                ${kwChips?`<div class="kc-scores" style="margin-top:0.2rem">${kwChips}</div>`:""}
                ${dm?.bilingual?`<span class="tag tag-bilingual" style="font-size:0.65rem">🌐 Bilingual</span>`:""}
            </div>`;
        }
        html += `</div></div>`;
    }
    document.getElementById("kanban").innerHTML = html;
}

// --- SCORECARD ---
function renderScorecard() {
    const sc = getScorecard();
    const el = document.getElementById("sc-current");
    if (sc.length) {
        const cats = {};
        for (const s of sc) { const c = s.category || "Other"; if (!cats[c]) cats[c] = []; cats[c].push(s); }
        let html = `<article><header><h4>Current Scorecard (${sc.length} skills)</h4></header><div class="overflow-auto"><table role="grid"><thead><tr><th>Category</th><th>Skill</th><th>Rating</th></tr></thead><tbody>`;
        for (const [cat, skills] of Object.entries(cats).sort()) {
            for (const s of skills) html += `<tr><td>${esc(cat)}</td><td>${esc(s.skill)}</td><td>${"★".repeat(s.rating)}${"☆".repeat(5-s.rating)}</td></tr>`;
        }
        html += `</tbody></table></div></article>`;
        el.innerHTML = html;

        const rows = document.getElementById("sc-rows");
        rows.innerHTML = "";
        for (const s of sc) addScorecardRow(s.category, s.skill, s.rating);
    } else {
        el.innerHTML = "";
        document.getElementById("sc-rows").innerHTML = "";
        addScorecardRow(); addScorecardRow(); addScorecardRow();
    }
}

function addScorecardRow(cat, skill, rating) {
    const rows = document.getElementById("sc-rows");
    const row = document.createElement("div");
    row.className = "sc-row";
    row.innerHTML = `<input type="text" placeholder="Category" value="${esc(cat||"")}"><input type="text" placeholder="Skill name" value="${esc(skill||"")}"><select>${[1,2,3,4,5].map(n=>`<option value="${n}" ${n===(rating||3)?"selected":""}>${n}</option>`).join("")}</select><button class="outline small" onclick="this.parentElement.remove()">✕</button>`;
    rows.appendChild(row);
}

function saveEditorScorecard() {
    const rows = document.querySelectorAll("#sc-rows .sc-row");
    const sc = [];
    for (const row of rows) {
        const inputs = row.querySelectorAll("input");
        const sel = row.querySelector("select");
        const cat = inputs[0].value.trim();
        const skill = inputs[1].value.trim();
        const rating = parseInt(sel.value) || 3;
        if (skill) sc.push({ category: cat, skill, rating });
    }
    if (!sc.length) { alert("Add at least one skill."); return; }
    saveScorecard(sc);
    recomputeScores();
    document.getElementById("cv-banner").style.display = "none";
    renderScorecard();
    alert(`Scorecard saved with ${sc.length} skills. Match scores updated.`);
}

function importScorecard() {
    const raw = document.getElementById("sc-paste").value.trim();
    if (!raw) return;
    const sc = [];
    const lines = raw.split("\n");
    for (const line of lines) {
        const clean = line.replace(/^\||\|$/g, "").trim();
        if (!clean || /^[-:|\s]+$/.test(clean) || /category/i.test(clean) && /skill/i.test(clean)) continue;
        const parts = clean.split(/[|\t]/).map(p => p.trim()).filter(Boolean);
        if (parts.length >= 3) {
            const rating = parseInt(parts[parts.length - 1]);
            if (rating >= 1 && rating <= 5) {
                sc.push({ category: parts[0], skill: parts[1], rating });
            }
        } else if (parts.length === 2) {
            const rating = parseInt(parts[1]);
            if (rating >= 1 && rating <= 5) {
                sc.push({ category: "", skill: parts[0], rating });
            }
        }
    }
    if (!sc.length) { alert("Could not parse any skills. Use format: Category | Skill | Rating"); return; }
    saveScorecard(sc);
    recomputeScores();
    document.getElementById("cv-banner").style.display = "none";
    document.getElementById("sc-paste").value = "";
    renderScorecard();
    alert(`Imported ${sc.length} skills. Match scores updated.`);
}

function clearScorecard() {
    localStorage.removeItem("jh_scorecard");
    for (const j of JOBS) { j._dm = null; j._domainScore = 0; j._mustScore = 0; j._niceScore = 0; j._bilingual = false; }
    document.getElementById("cv-banner").style.display = "flex";
    renderScorecard();
    applyFilters();
}

// --- CSV EXPORT ---
function exportCSV() {
    const uj = getUserJobs();
    const tracked = JOBS.filter(j => { const s = uj[j.url]?.status; return s && TRACKER_COLS.includes(s); });
    if (!tracked.length) { alert("No tracked jobs to export."); return; }
    let csv = "Title,Company,URL,Location,Work Mode,Employment Type,Department,Salary,Status,Notes,Keywords Matched,Domain%,Must%,Nice%,Bilingual\n";
    for (const j of tracked) {
        const u = uj[j.url]||{};
        csv += [j.title,j.source,j.url,j.location,j.work_mode,j.employment_type,j.department,j.salary_text,u.status,u.notes||"",(j._matchedKw||[]).join("; "),j._domainScore||0,j._mustScore||0,j._niceScore||0,j._bilingual?"yes":"no"].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",")+"\n";
    }
    const blob = new Blob([csv], {type:"text/csv"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "jobhunter_export.csv";
    a.click();
}

init();

const APP_VERSION = "0.9.3";
const VERSION_HISTORY = [
    {v:"0.9.3",d:"2026-06-27",c:["Job title multi-select with typeahead from cleaned seed titles","Title cleaning: strips gender markers, company names, seniority prefixes","Custom title entry via Enter key"]},
    {v:"0.9.2",d:"2026-06-27",c:["Search criteria expanded to all of Germany","Retrieved date filter and display","232 jobs seeded from 82 sources"]},
    {v:"0.9.0",d:"2026-06-27",c:["Must-have vs nice-to-have requirement detection","Red flag on jobs with <50% must-have match","Hybrid section + inline cue classification (EN/DE)","Match breakdown in detail modal"]},
    {v:"0.8.0",d:"2026-06-27",c:["Static GitHub Pages architecture","Pre-seeded job data (no server needed)","All user state in localStorage","CV matching runs in browser"]},
    {v:"0.7.0",d:"2026-06-23",c:["Arbeitsagentur API, 4dayweek, 82 plugins"]},
    {v:"0.6.0",d:"2026-06-23",c:["Kanban tracker, job detail modal, sector tabs"]},
    {v:"0.5.0",d:"2026-06-23",c:["CV matching, date filters, Remotive/Arbeitnow/Himalayas"]},
    {v:"0.4.0",d:"2026-06-22",c:["Live scraping progress, enhanced filters, CSV export"]},
    {v:"0.3.0",d:"2026-06-22",c:["60 plugins, Greenhouse/SmartRecruiters/Celonis"]},
];
const STATUSES = ["new","favorite","apply","applied","interview","rejected","withdrawn","hidden"];
const TRACKER_COLS = ["favorite","apply","applied","interview","rejected","withdrawn"];

let JOBS = [];
let SEED_META = {};
let currentDetailIdx = null;

// --- STORAGE ---
function loadState(key, def) { try { return JSON.parse(localStorage.getItem("jh_"+key)) || def; } catch { return def; } }
function saveState(key, val) { localStorage.setItem("jh_"+key, JSON.stringify(val)); }
function getUserJobs() { return loadState("user_jobs", {}); }
function setUserJob(url, data) { const uj = getUserJobs(); uj[url] = {...(uj[url]||{}), ...data}; saveState("user_jobs", uj); }
function getCV() { return loadState("cv_text", ""); }

// --- MATCHING ---
const STOP = new Set("a an the and or but in on at to for of is are was were be been being have has had do does did will would shall should may might can could this that these those it its with from by as into through during before after above below between out off over under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very just about up also well back even still new now old get got make made way us our them their we you your he she they him his her who what which whom me my myself we our ours ourselves she her hers herself he his him himself they their theirs themselves itself i am if job role work team company will join looking apply please candidate required requirements experience years year must strong good great key ability able ensure including include includes working within across using used use part based responsible responsibilities description qualifications preferred ideal join help build create support der die das ein eine einer eines einem den dem und oder aber in auf zu für von ist sind war waren wird werden hat haben wir sie er es mit als auch nach über bei aus durch noch nicht oder ihre ihr ihren seiner seinem wenn an um eine einen am dann so dass ob schon".split(" "));
const BOOST = new Set("saas b2b b2c enterprise startup fintech insurtech healthtech traveltech airline aviation booking reservation gds amadeus hospitality gdpr compliance security iso soc product management roadmap okr kpi stakeholder project pmp prince2 waterfall lean six sigma leadership strategy budget revenue growth jira confluence git github gitlab figma sketch power bi airflow etl spark hadoop docker kubernetes aws azure gcp ansible rest api graphql microservices salesforce hubspot shopify stripe snowflake databricks kafka elasticsearch sap oracle workday personio agile scrum kanban ci cd devops german english spanish bilingual multilingual".split(" "));

function extractKeywords(text) {
    const words = text.toLowerCase().replace(/<[^>]+>/g," ").replace(/[^\w\s+#.]/g," ").split(/\s+/);
    const counts = {};
    for (const w of words) { const c = w.replace(/\./g,""); if (c.length < 2 || STOP.has(c) || /^\d+$/.test(c)) continue; counts[c] = (counts[c]||0)+1; }
    return counts;
}

const MUST_HEADERS = /(?:must.?have|required|requirements|what you.?(?:ll )?need|what we.?(?:re )?looking for|you bring|qualifications|essential|anforderungen|voraussetzungen|was du mitbringst|das bringst du mit|dein profil|ihr profil|what you.?(?:ll )?bring|your profile|key requirements)/i;
const NICE_HEADERS = /(?:nice.?to.?have|bonus|preferred|desirable|optional|ideally|additional|plus|advantageous|beneficial|w[üu]nschenswert|von vorteil|idealerweise|zus[äa]tzlich|what.?s a plus|it.?s a bonus|extra points|good to have)/i;
const MUST_CUES = /(?:must have|required|essential|mandatory|necessary|critical|you must|we require|is required|are required|zwingend|erforderlich|notwendig)/i;
const NICE_CUES = /(?:nice to have|bonus|preferred|ideally|preferably|desirable|a plus|an advantage|not required|optional|beneficial|von vorteil|w[üu]nschenswert|idealerweise|gerne gesehen|nicht zwingend)/i;

function classifyRequirements(desc) {
    if (!desc) return { must: {}, nice: {} };
    const lines = desc.replace(/<[^>]+>/g, "\n").split("\n").filter(l => l.trim());
    let current = "must", sectionFound = false;
    const mustLines = [], niceLines = [];
    for (const line of lines) {
        const s = line.trim();
        if (NICE_HEADERS.test(s)) { current = "nice"; sectionFound = true; continue; }
        if (MUST_HEADERS.test(s)) { current = "must"; sectionFound = true; continue; }
        if (current === "must") mustLines.push(s); else niceLines.push(s);
    }
    if (sectionFound) return { must: extractKeywords(mustLines.join(" ")), nice: extractKeywords(niceLines.join(" ")) };
    const ml = [], nl = [];
    for (const line of lines) {
        const s = line.trim();
        if (NICE_CUES.test(s)) nl.push(s);
        else ml.push(s);
    }
    return { must: extractKeywords(ml.join(" ")), nice: extractKeywords(nl.join(" ")) };
}

function matchScore(jobText, cvText) {
    if (!jobText || !cvText) return 0;
    const jk = extractKeywords(jobText), ck = extractKeywords(cvText);
    let entries = Object.entries(jk).map(([w,c]) => [w, c * (BOOST.has(w)?2:1)]);
    entries.sort((a,b) => b[1]-a[1]);
    entries = entries.slice(0,50);
    if (!entries.length) return 0;
    let matched=0, total=0;
    for (const [w,wt] of entries) { total+=wt; if (ck[w]) matched+=wt; }
    return Math.min(Math.round((matched/total)*10), 10);
}

function detailedMatch(jobText, cvText, description) {
    const result = { score:0, mustScore:0, niceScore:0, mustTotal:0, mustMatched:0, niceTotal:0, niceMatched:0, mustFlag:false, matchedMusts:[], missingMusts:[], matchedNices:[], missingNices:[] };
    if (!jobText || !cvText) return result;
    const cv = extractKeywords(cvText);
    const { must: mustKw, nice: niceKw } = classifyRequirements(description || jobText);
    const allKw = extractKeywords(jobText);
    let entries = Object.entries(allKw).map(([w,c]) => [w, c * (BOOST.has(w)?2:1)]);
    entries.sort((a,b) => b[1]-a[1]);
    entries = entries.slice(0,50);
    const mustWords = new Set(), niceWords = new Set();
    for (const [w] of entries) { if (niceKw[w] && !mustKw[w]) niceWords.add(w); else mustWords.add(w); }
    for (const [w] of entries) {
        if (mustWords.has(w)) { result.mustTotal++; if (cv[w]) { result.mustMatched++; result.matchedMusts.push(w); } else result.missingMusts.push(w); }
        if (niceWords.has(w)) { result.niceTotal++; if (cv[w]) { result.niceMatched++; result.matchedNices.push(w); } else result.missingNices.push(w); }
    }
    if (result.mustTotal) result.mustScore = Math.round((result.mustMatched/result.mustTotal)*100);
    if (result.niceTotal) result.niceScore = Math.round((result.niceMatched/result.niceTotal)*100);
    result.mustFlag = result.mustTotal > 0 && result.mustScore < 50;
    result.score = matchScore(jobText, cvText);
    return result;
}

// --- SECTOR ---
const SECTOR_MAP = {engineering:["engineering","software","development","backend","frontend","fullstack","devops","infrastructure"],product:["product","product management"],design:["design","ux","ui","creative"],data:["data","analytics","machine learning","ai","artificial intelligence"],marketing:["marketing","growth","content","brand"],sales:["sales","business development","account","revenue"],operations:["operations","supply chain","logistics","project management"],finance:["finance","accounting","tax","treasury"],hr:["human resources","hr","people","talent","recruiting"],"legal & compliance":["legal","compliance","regulatory","risk"],customer:["customer","support","service","success","client"],it:["it","information technology","security","infosec"]};
function getSector(dept) {
    if (!dept) return "Other";
    const l = dept.toLowerCase();
    for (const [s,kws] of Object.entries(SECTOR_MAP)) { for (const k of kws) if (l.includes(k)) return s.charAt(0).toUpperCase()+s.slice(1); }
    return "Other";
}

// --- FAVICON ---
function faviconUrl(baseUrl) { try { return `https://www.google.com/s2/favicons?domain=${new URL(baseUrl).hostname}&sz=64`; } catch { return ""; } }

// --- INIT ---
async function init() {
    document.getElementById("version-display").textContent = `v${APP_VERSION}`;
    let vh = "";
    for (const v of VERSION_HISTORY) { vh += `<div class="version-entry"><h4>v${v.v} <small>(${v.d})</small></h4><ul>${v.c.map(c=>`<li>${c}</li>`).join("")}</ul></div>`; }
    document.getElementById("version-history").innerHTML = vh;

    const r = await fetch("data/jobs.json");
    const data = await r.json();
    JOBS = data.jobs || [];
    SEED_META = data;

    document.getElementById("seed-info").innerHTML = `<small>Data seeded: <strong>${data.seeded_at?.slice(0,16).replace("T"," ")||"?"} UTC</strong> · ${data.total_jobs} jobs from ${data.sources_queried} sources</small>`;

    const cv = getCV();
    if (cv) {
        for (const j of JOBS) {
            const jt = `${j.title} ${j.description||""} ${j.department||""}`;
            const dm = detailedMatch(jt, cv, j.description||"");
            j._score = dm.score;
            j._mustScore = dm.mustScore;
            j._mustFlag = dm.mustFlag;
            j._mustTotal = dm.mustTotal;
            j._mustMatched = dm.mustMatched;
            j._niceScore = dm.niceScore;
            j._niceTotal = dm.niceTotal;
            j._niceMatched = dm.niceMatched;
        }
    }
    buildTitleOptions();
    document.getElementById("cv-banner").style.display = cv ? "none" : "flex";
    if (cv) { document.getElementById("cv-current").innerHTML = `<article><p><strong>CV loaded</strong> (${cv.length} chars) · <a href="#" onclick="clearCV()">Remove</a></p></article>`; }

    initTitleFilter();
    applyFilters();
    buildStatusSelect(document.getElementById("detail-status"));
}

function buildStatusSelect(sel) {
    sel.innerHTML = STATUSES.filter(s=>s!=="new"&&s!=="hidden").map(s=>`<option value="${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join("") + `<option value="new">New (reset)</option>`;
}

// --- VIEWS ---
function showView(name) {
    ["feed","tracker","cv"].forEach(v => {
        document.getElementById("view-"+v).style.display = v===name?"":"none";
        document.querySelector(`.nav-link[data-view="${v}"]`).classList.toggle("active", v===name);
    });
    if (name === "tracker") renderKanban();
    if (name === "cv") renderCV();
}

// --- TITLE CLEANING ---
function cleanTitle(raw) {
    let t = raw;
    // Remove gender markers
    t = t.replace(/\s*\(?\s*[mwfd]\s*[\/\|]\s*[mwfd]\s*(?:[\/\|]\s*[mwfd])?\s*\)?\s*/gi, " ");
    t = t.replace(/\s*\(?\s*all\s+genders?\s*\)?\s*/gi, " ");
    t = t.replace(/\s*\(?\s*gn\s*\)?\s*/gi, " ");
    t = t.replace(/\*\s*in\b/g, "");
    // Remove everything after separators that indicate company/location
    t = t.replace(/\s*[|@—–]\s*.{3,}$/, "");
    t = t.replace(/\s+(?:bei|at|für|for)\s+[A-Z].{2,}$/, "");
    // Remove leading (Senior) / (Junior) etc in parens — keep the core title
    t = t.replace(/^\s*\((?:Senior|Junior|Lead|Staff|Principal|Head of)\)\s*/i, "");
    // Remove seniority prefix for grouping
    t = t.replace(/^\s*(?:Senior|Junior|Lead|Principal|Staff|Head of|Sr\.|Jr\.)\s+/i, "");
    // Clean up
    t = t.replace(/\s{2,}/g, " ").replace(/\s*[-–—]\s*$/, "").trim();
    return t;
}

let TITLE_OPTIONS = [];
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
    const minMatch = parseInt(document.getElementById("f-match").value)||0;
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
        if (minMatch && (j._score||0) < minMatch) return false;
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
    else if (sort === "match_desc") filtered.sort((a,b) => (b._score||0)-(a._score||0));
    else filtered.reverse();

    renderSectorTabs(filtered);
    renderJobs(filtered);
}

function clearFilters() {
    ["f-location","f-company","f-dept","f-exclude","f-date-from","f-date-to"].forEach(id => document.getElementById(id).value = "");
    selectedTitles.clear();
    document.getElementById("title-chips").innerHTML = "";
    document.getElementById("title-search").value = "";
    ["f-workmode","f-level","f-status"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("f-match").value = "0";
    document.getElementById("f-sort").value = "date_desc";
    applyFilters();
}

// --- SECTOR TABS ---
let currentSector = "all";
function renderSectorTabs(jobs) {
    const sectors = {};
    for (const j of jobs) { const s = getSector(j.department); sectors[s] = (sectors[s]||0)+1; }
    const names = Object.keys(sectors).sort();
    let html = `<button class="tab-btn ${currentSector==="all"?"active":""}" onclick="filterSector('all')">All (${jobs.length})</button>`;
    for (const s of names) html += `<button class="tab-btn ${currentSector===s?"active":""}" onclick="filterSector('${s}')">${s} (${sectors[s]})</button>`;
    document.getElementById("sector-tabs").innerHTML = html;
}

function filterSector(s) { currentSector = s; applyFilters(); }

// --- RENDER JOBS ---
function renderJobs(jobs) {
    const uj = getUserJobs();
    const list = document.getElementById("job-list");
    let html = "";
    let count = 0;
    for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        if (currentSector !== "all" && getSector(j.department) !== currentSector) continue;
        const st = uj[j.url]?.status || "new";
        const fav = faviconUrl(j.source_url||"");
        const initial = (j.source||"?")[0];
        const score = j._score||0;
        count++;
        html += `<article class="job-card" data-url="${esc(j.url)}">
            <div class="job-card-body">
                <div class="job-logo"><img src="${fav}" width="48" height="48" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22><rect width=%2248%22 height=%2248%22 rx=%228%22 fill=%22%23667%22/><text x=%2224%22 y=%2232%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2220%22>${initial}</text></svg>'"></div>
                <div class="job-info">
                    <h3><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></h3>
                    <div class="job-company">${esc(j.source)}</div>
                    <div class="job-tags">
                        ${j.location?`<span class="tag tag-location">${esc(j.location)}</span>`:""}
                        ${j.work_mode?`<span class="tag tag-workmode">${esc(j.work_mode)}</span>`:""}
                        ${j.employment_type?`<span class="tag tag-type">${esc(j.employment_type)}</span>`:""}
                        ${j.department?`<span class="tag tag-dept">${esc(j.department)}</span>`:""}
                        ${j.seniority?`<span class="tag tag-seniority">${esc(j.seniority)}</span>`:""}
                        ${j.salary_text?`<span class="tag tag-salary">${esc(j.salary_text)}</span>`:""}
                    </div>
                    ${j.description?`<p class="job-description">${esc((j.description||"").slice(0,250))}${(j.description||"").length>250?"...":""}</p>`:""}
                    <div class="job-footer">
                        <small class="job-date" title="Retrieved: ${(j.retrieved_at||"").slice(0,16).replace("T"," ")}">${(j.retrieved_at||j.first_seen||"").slice(0,10)}</small>
                        ${score?`<span class="match-badge match-${score>=8?"high":score>=5?"mid":"low"}">${score}/10</span>`:""}
                        ${j._mustFlag?`<span class="must-flag" title="Must-have match below 50%">⚠ Must-haves: ${j._mustMatched||0}/${j._mustTotal||0}</span>`:""}
                        ${(j._mustTotal && !j._mustFlag)?`<span class="must-ok" title="Must-have match">${j._mustMatched}/${j._mustTotal} musts</span>`:""}
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
    if (j._score) { const cls = j._score>=8?"high":j._score>=5?"mid":"low"; meta += ` · <span class="match-badge match-${cls}">${j._score}/10</span>`; }
    document.getElementById("detail-meta").innerHTML = meta;

    let kwHtml = "";
    const cv = getCV();
    if (cv && j.description) {
        const jt = `${j.title} ${j.description} ${j.department||""}`;
        const dm = detailedMatch(jt, cv, j.description);

        if (dm.mustTotal || dm.niceTotal) {
            kwHtml += `<div class="match-breakdown">`;
            if (dm.mustTotal) {
                kwHtml += `<div class="mb-row ${dm.mustFlag?"mb-flag":""}"><strong>Must-haves:</strong> ${dm.mustMatched}/${dm.mustTotal} (${dm.mustScore}%)${dm.mustFlag?" ⚠":""}`;
                if (dm.matchedMusts.length) kwHtml += `<br>${dm.matchedMusts.map(w=>`<span class="kw-match">${w}</span>`).join(" ")}`;
                if (dm.missingMusts.length) kwHtml += `<br>${dm.missingMusts.map(w=>`<span class="kw-miss">${w}</span>`).join(" ")}`;
                kwHtml += `</div>`;
            }
            if (dm.niceTotal) {
                kwHtml += `<div class="mb-row"><strong>Nice-to-haves:</strong> ${dm.niceMatched}/${dm.niceTotal} (${dm.niceScore}%)`;
                if (dm.matchedNices.length) kwHtml += `<br>${dm.matchedNices.map(w=>`<span class="kw-match">${w}</span>`).join(" ")}`;
                if (dm.missingNices.length) kwHtml += `<br>${dm.missingNices.map(w=>`<span class="kw-miss">${w}</span>`).join(" ")}`;
                kwHtml += `</div>`;
            }
            kwHtml += `</div>`;
        }
    }
    document.getElementById("detail-keywords").innerHTML = kwHtml;
    document.getElementById("detail-description").textContent = j.description || "No description available.";
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
            const score = j._score||0;
            html += `<div class="kanban-card" onclick="openDetail(${JOBS.indexOf(j)})">
                <div class="kc-title">${esc(j.title.slice(0,40))}${j.title.length>40?"...":""}</div>
                <div class="kc-company">${esc(j.source)}</div>
                <div class="kc-meta">
                    ${j.location?`<span>${esc(j.location.slice(0,15))}${j.location.length>15?"…":""}</span>`:""}
                    ${j.work_mode?`<span class="tag tag-workmode">${esc(j.work_mode)}</span>`:""}
                    ${j.salary_text?`<span class="tag tag-salary">${esc(j.salary_text.slice(0,20))}</span>`:""}
                </div>
                ${score?`<span class="match-badge match-${score>=8?"high":score>=5?"mid":"low"}">${score}/10</span>`:""}
            </div>`;
        }
        html += `</div></div>`;
    }
    document.getElementById("kanban").innerHTML = html;
}

// --- CV ---
function renderCV() {
    const cv = getCV();
    if (cv) {
        document.getElementById("cv-current").innerHTML = `<article><header><h4>Current CV</h4></header><p><strong>Length:</strong> ${cv.length} chars · <a href="#" onclick="clearCV(); return false;">Remove</a></p><details><summary>Preview</summary><pre class="cv-preview">${esc(cv.slice(0,3000))}${cv.length>3000?"...":""}</pre></details></article>`;
        document.getElementById("cv-input").value = "";
    } else {
        document.getElementById("cv-current").innerHTML = "";
    }
}

function saveCV() {
    const text = document.getElementById("cv-input").value.trim();
    if (!text) return;
    saveState("cv_text", text);
    for (const j of JOBS) {
        const jt = `${j.title} ${j.description||""} ${j.department||""}`;
        const dm = detailedMatch(jt, text, j.description||"");
        j._score = dm.score;
        j._mustScore = dm.mustScore;
        j._mustFlag = dm.mustFlag;
        j._mustTotal = dm.mustTotal;
        j._mustMatched = dm.mustMatched;
        j._niceScore = dm.niceScore;
        j._niceTotal = dm.niceTotal;
        j._niceMatched = dm.niceMatched;
    }
    document.getElementById("cv-banner").style.display = "none";
    renderCV();
    alert(`CV saved (${text.length} characters). Match scores updated.`);
}

function clearCV() {
    localStorage.removeItem("jh_cv_text");
    for (const j of JOBS) j._score = 0;
    document.getElementById("cv-banner").style.display = "flex";
    document.getElementById("cv-current").innerHTML = "";
}

// --- CSV EXPORT ---
function exportCSV() {
    const uj = getUserJobs();
    const tracked = JOBS.filter(j => { const s = uj[j.url]?.status; return s && TRACKER_COLS.includes(s); });
    if (!tracked.length) { alert("No tracked jobs to export."); return; }
    let csv = "Title,Company,URL,Location,Work Mode,Employment Type,Department,Salary,Status,Notes,Match Score\n";
    for (const j of tracked) {
        const u = uj[j.url]||{};
        csv += [j.title,j.source,j.url,j.location,j.work_mode,j.employment_type,j.department,j.salary_text,u.status,u.notes||"",j._score||0].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",")+"\n";
    }
    const blob = new Blob([csv], {type:"text/csv"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "jobhunter_export.csv";
    a.click();
}

init();

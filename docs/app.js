const APP_VERSION = "3.0.0";
const VERSION_HISTORY = [
    {v:"3.0.0",d:"2026-07-10",c:["Full skills assessment framework — 37 skills, 6 dimensions, 0–5 button ratings","Editable scoring formula via weight sliders per dimension","Role scores for BA, PO, PM based on skill relevance","'Min rated skills' feed filter — only show jobs mentioning your high-rated skills","'Skills match' chip on job cards showing how many qualifying skills appear","Category scores with collapsible sections; mobile cards / desktop 2-column grid","Reseeded: product + analyst as separate searches"]},
    {v:"2.0.0",d:"2026-07-09",c:["Select your Skills page — toggle keywords from config, see job counts per keyword","Keyword extraction from job descriptions using keywords.json config","Matched keywords shown as chips on every job card","Keyword multiselect filter on feed (must include ALL selected keywords)","Sort by number of keywords matched","Seeding expanded: 4 role types, UK + DE + EU fallback locations, 3-day freshness filter"]},
    {v:"1.3.1",d:"2026-07-07",c:["Indeed DE added as job source","418 jobs total, 3-day freshness filter, UK + EU searches","Seeding: business analyst, product analyst, product owner, product manager"]},
    {v:"1.3.0",d:"2026-07-07",c:["3 separate match scores: Domain %, Must-have %, Nice-to-have %","Bilingual detection: flags jobs requiring German + English","Domain-based tabs from scorecard categories","Expandable match breakdown on every job card"]},
    {v:"1.2.0",d:"2026-06-30",c:["6 new airline & travel-tech sources","New Workable and career.aero scrapers","277+ jobs seeded"]},
    {v:"1.0.0",d:"2026-06-29",c:["Scorecard-based matching","All user state in localStorage"]},
];
const STATUSES = ["new","favorite","apply","applied","interview","rejected","withdrawn","hidden"];
const TRACKER_COLS = ["favorite","apply","applied","interview","rejected","withdrawn"];

let JOBS = [];
let SEED_META = {};
let KEYWORD_CONFIG = [];
let FRAMEWORK = {};
let currentDetailIdx = null;

// --- STORAGE ---
function loadState(key, def) { try { return JSON.parse(localStorage.getItem("jh_"+key)) ?? def; } catch { return def; } }
function saveState(key, val) { localStorage.setItem("jh_"+key, JSON.stringify(val)); }
function getUserJobs() { return loadState("user_jobs", {}); }
function setUserJob(url, data) { const uj = getUserJobs(); uj[url] = {...(uj[url]||{}), ...data}; saveState("user_jobs", uj); }
function getMySkills() { return new Set(loadState("my_skills", [])); }
function saveMySkills(skills) { saveState("my_skills", [...skills]); }

// --- SKILLS FRAMEWORK STORAGE ---
function getSkillScores() {
    const saved = loadState("skill_scores_v3", null);
    if (saved) return saved;
    // Pre-populate from framework initial_scores
    const scores = {};
    for (const skill of (FRAMEWORK.skills || [])) {
        if (skill.initial_scores && Object.values(skill.initial_scores).some(v => v > 0)) {
            scores[skill.name] = { ...skill.initial_scores };
        }
    }
    return scores;
}
function saveSkillScores(scores) { saveState("skill_scores_v3", scores); }
function getFormulaWeights() {
    const saved = loadState("formula_weights", null);
    if (saved) return saved;
    const defaults = {};
    for (const d of (FRAMEWORK.dimensions || [])) defaults[d.key] = 1.0;
    return defaults;
}
function saveFormulaWeights(w) { saveState("formula_weights", w); }

function skillId(name) { return name.replace(/[^a-zA-Z0-9]/g, "-"); }
function hasAnyScore(dimScores) { return dimScores && Object.values(dimScores).some(v => v > 0); }

// --- SCORE COMPUTATION ---
function computeSkillScore(dimScores, weights) {
    let totalW = 0, weightedSum = 0;
    for (const dim of FRAMEWORK.dimensions) {
        const w = weights[dim.key] ?? 1;
        totalW += w;
        weightedSum += (dimScores[dim.key] || 0) * w;
    }
    return totalW > 0 ? Math.round(weightedSum / totalW * 100) / 100 : 0;
}

function computeAllSkillScores() {
    const saved = getSkillScores();
    const weights = getFormulaWeights();
    const result = {};
    for (const s of FRAMEWORK.skills) {
        result[s.name] = computeSkillScore(saved[s.name] || {}, weights);
    }
    return result;
}

function computeCategoryScore(category, allComputedScores) {
    const rawScores = getSkillScores();
    const catSkills = FRAMEWORK.skills.filter(s => s.category === category);
    const ratedSkills = catSkills.filter(s => hasAnyScore(rawScores[s.name]));
    if (!ratedSkills.length) return 0;
    return ratedSkills.reduce((sum, s) => sum + (allComputedScores[s.name] || 0), 0) / ratedSkills.length;
}

function computeRoleScores(allComputedScores) {
    const rawScores = getSkillScores();
    const result = {};
    for (const role of FRAMEWORK.roles) {
        const roleSkills = FRAMEWORK.skills.filter(s => s.roles.includes(role.key));
        const ratedSkills = roleSkills.filter(s => hasAnyScore(rawScores[s.name]));
        result[role.key] = ratedSkills.length
            ? ratedSkills.reduce((sum, s) => sum + (allComputedScores[s.name] || 0), 0) / ratedSkills.length
            : 0;
    }
    return result;
}

// --- KEYWORD MATCHING ---
function computeKeywords(j) {
    if (!KEYWORD_CONFIG.length) return [];
    const text = ((j.title || "") + " " + (j.description || "")).toLowerCase();
    return KEYWORD_CONFIG.filter(kw => text.includes(kw.toLowerCase()));
}

// --- BILINGUAL DETECTION ---
const GERMAN_LANG = /\b(german|deutsch(?:e?|kenntnisse)?)\b/i;
const ENGLISH_LANG = /\b(english|englisch(?:e?|kenntnisse)?)\b/i;

// --- SKILLS MATCH ---
function allJobSkills(j) {
    // Union of confirmed keyword matches, context inferences, and LLM extractions
    const names = new Set(j._matched_skills || []);
    for (const n of (j._inferred_skills || [])) names.add(n);
    const ext = j._extracted_skills || {};
    for (const n of (ext.required || [])) names.add(n);
    for (const n of (ext.preferred || [])) names.add(n);
    return names;
}

function recomputeSkillsMatch(threshold) {
    if (!FRAMEWORK.skills || threshold <= 0) {
        for (const j of JOBS) j._skillsMatch = 0;
        return;
    }
    const computedScores = computeAllSkillScores();
    const qualifyingNames = new Set(
        FRAMEWORK.skills
            .filter(s => (computedScores[s.name] || 0) >= threshold)
            .map(s => s.name)
    );
    for (const j of JOBS) {
        j._skillsMatch = [...allJobSkills(j)].filter(n => qualifyingNames.has(n)).length;
    }
}

function recomputeScores() {
    for (const j of JOBS) {
        const plain = (j.description || "").replace(/<[^>]+>/g, " ");
        j._bilingual = GERMAN_LANG.test(plain) && ENGLISH_LANG.test(plain);
        j._matchedKw = computeKeywords(j);
        j._kwCount = j._matchedKw.length;
        j._skillsMatch = 0;
    }
}

// --- SECTOR ---
const SECTOR_MAP = {engineering:["engineering","software","development","backend","frontend","fullstack","devops"],product:["product management","product owner"],design:["design","ux","ui"],data:["data","analytics","machine learning","ai"],marketing:["marketing","growth","content","brand"],sales:["sales","business development","account"],operations:["operations","supply chain","logistics","project management"],finance:["finance","accounting","treasury"],hr:["human resources","hr","people","talent","recruiting"]};
function getSector(dept) {
    if (!dept) return "Other";
    const l = dept.toLowerCase();
    for (const [s,kws] of Object.entries(SECTOR_MAP)) { for (const k of kws) if (l.includes(k)) return s.charAt(0).toUpperCase()+s.slice(1); }
    return "Other";
}
function faviconUrl(baseUrl) { try { return `https://www.google.com/s2/favicons?domain=${new URL(baseUrl).hostname}&sz=64`; } catch { return ""; } }

// --- INIT ---
async function init() {
    document.getElementById("version-display").textContent = `v${APP_VERSION}`;
    let vh = "";
    for (const v of VERSION_HISTORY) { vh += `<div class="version-entry"><h4>v${v.v} <small>(${v.d})</small></h4><ul>${v.c.map(c=>`<li>${c}</li>`).join("")}</ul></div>`; }
    document.getElementById("version-history").innerHTML = vh;

    const [jobsResp, kwResp, fwResp] = await Promise.all([
        fetch("data/jobs.json"),
        fetch("data/keywords.json"),
        fetch("data/skills_framework.json"),
    ]);
    const data = await jobsResp.json();
    const kwData = await kwResp.json();
    FRAMEWORK = await fwResp.json();

    JOBS = data.jobs || [];
    SEED_META = data;
    KEYWORD_CONFIG = kwData.keywords || [];

    document.getElementById("seed-info").innerHTML = `<small>Data seeded: <strong>${data.seeded_at?.slice(0,16).replace("T"," ")||"?"} UTC</strong> · ${data.total_jobs} jobs from ${data.sources_queried} sources</small>`;

    recomputeScores();
    buildTitleOptions();
    initTitleFilter();
    initKeywordFilter();
    buildStatusSelect(document.getElementById("detail-status"));

    showView("assessment");
}

function buildStatusSelect(sel) {
    sel.innerHTML = STATUSES.filter(s=>s!=="new"&&s!=="hidden").map(s=>`<option value="${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join("") + `<option value="new">New (reset)</option>`;
}

// --- VIEWS ---
function showView(name) {
    ["feed","tracker","assessment","keywords"].forEach(v => {
        document.getElementById("view-"+v).style.display = v===name?"":"none";
        const link = document.querySelector(`.nav-link[data-view="${v}"]`);
        if (link) link.classList.toggle("active", v===name);
    });
    if (name === "tracker") renderKanban();
    if (name === "assessment") renderAssessmentPage();
    if (name === "keywords") renderKeywordsPage();
    if (name === "feed") applyFilters();
}

// --- ASSESSMENT PAGE ---
function renderAssessmentPage() {
    if (!FRAMEWORK.skills) return;

    // Save open state
    const openCats = new Set();
    document.querySelectorAll("#assessment-categories details[open]").forEach(d => openCats.add(d.dataset.cat));
    const formulaWasOpen = document.getElementById("formula-editor")?.hasAttribute("open");

    const allScores = computeAllSkillScores();
    const weights = getFormulaWeights();
    const rawScores = getSkillScores();

    // Role summary
    const roleScores = computeRoleScores(allScores);
    let roleSummaryHtml = FRAMEWORK.roles.map(role => {
        const score = roleScores[role.key];
        const pct = Math.round(score / 5 * 100);
        const roleSkills = FRAMEWORK.skills.filter(s => s.roles.includes(role.key));
        const ratedCount = roleSkills.filter(s => hasAnyScore(rawScores[s.name])).length;
        return `<div class="role-score-card">
            <div class="role-score-label">${esc(role.label)}</div>
            <div class="role-score-value">${score > 0 ? score.toFixed(1) : "—"}</div>
            <progress value="${pct}" max="100" class="role-progress"></progress>
            <div class="role-score-sub">${ratedCount}/${roleSkills.length} skills rated</div>
        </div>`;
    }).join("");
    document.getElementById("assessment-role-summary").innerHTML = roleSummaryHtml;

    // Formula editor
    renderFormulaEditor(weights);

    // Categories
    const categorized = {};
    for (const skill of FRAMEWORK.skills) {
        if (!categorized[skill.category]) categorized[skill.category] = [];
        categorized[skill.category].push(skill);
    }

    let categoriesHtml = "";
    for (const [cat, skills] of Object.entries(categorized).sort()) {
        const catScore = computeCategoryScore(cat, allScores);
        const ratedCount = skills.filter(s => hasAnyScore(rawScores[s.name])).length;
        const isOpen = openCats.has(cat);
        categoriesHtml += `<details class="skill-category" data-cat="${esc(cat)}"${isOpen?" open":""}>
            <summary class="skill-category-summary">
                <span class="skill-cat-name">${esc(cat)}</span>
                <span class="skill-cat-meta">${ratedCount}/${skills.length} rated</span>
                <span class="skill-cat-score">${catScore > 0 ? catScore.toFixed(2) : "—"}</span>
            </summary>
            <div class="skill-cards-grid">
                ${skills.map(skill => renderSkillCard(skill, FRAMEWORK.skills.indexOf(skill), rawScores, allScores, weights)).join("")}
            </div>
        </details>`;
    }
    document.getElementById("assessment-categories").innerHTML = categoriesHtml;
    if (formulaWasOpen) document.getElementById("formula-editor").open = true;
}

function renderFormulaEditor(weights) {
    const totalW = Object.values(weights).reduce((s, v) => s + v, 0);
    const formulaParts = FRAMEWORK.dimensions.map(d => `${d.label.slice(0,2)}×${(weights[d.key]||1).toFixed(1)}`).join(" + ");

    const slidersHtml = FRAMEWORK.dimensions.map(dim => {
        const w = weights[dim.key] ?? 1;
        return `<div class="formula-slider-row">
            <label class="formula-label" title="${esc(dim.description)}">${esc(dim.label)}</label>
            <input type="range" min="0" max="2" step="0.1" value="${w}"
                   oninput="updateWeight('${dim.key}', parseFloat(this.value))"
                   class="formula-slider">
            <span class="formula-weight-val" id="fw-${dim.key}">${w.toFixed(1)}</span>
        </div>`;
    }).join("");

    document.getElementById("formula-editor-content").innerHTML = `
        <div class="formula-sliders">${slidersHtml}</div>
        <div class="formula-preview">score = (${formulaParts}) ÷ ${totalW.toFixed(1)}</div>
        <button class="outline secondary small" onclick="resetWeights()" style="margin-top:0.5rem">Reset to defaults</button>
    `;
}

function updateWeight(dimKey, value) {
    const weights = getFormulaWeights();
    weights[dimKey] = value;
    saveFormulaWeights(weights);

    document.getElementById(`fw-${dimKey}`).textContent = value.toFixed(1);

    const totalW = Object.values(weights).reduce((s, v) => s + v, 0);
    const formulaParts = FRAMEWORK.dimensions.map(d => `${d.label.slice(0,2)}×${(weights[d.key]||1).toFixed(1)}`).join(" + ");
    const preview = document.querySelector(".formula-preview");
    if (preview) preview.textContent = `score = (${formulaParts}) ÷ ${totalW.toFixed(1)}`;

    // Recompute all scores and update DOM
    const allScores = computeAllSkillScores();
    const rawScores = getSkillScores();

    document.querySelectorAll("[data-skill-idx]").forEach(card => {
        const idx = parseInt(card.dataset.skillIdx);
        const skill = FRAMEWORK.skills[idx];
        const dimScores = rawScores[skill.name] || {};
        const newScore = computeSkillScore(dimScores, weights);
        const hasSc = hasAnyScore(dimScores);
        const badge = card.querySelector(".skill-total-score");
        if (badge) {
            badge.textContent = hasSc ? newScore.toFixed(2) : "—";
            badge.className = `skill-total-score ${hasSc ? "rated" : "unrated"}`;
        }
    });

    const cats = [...new Set(FRAMEWORK.skills.map(s => s.category))];
    for (const cat of cats) {
        const el = document.querySelector(`[data-cat="${CSS.escape(cat)}"] .skill-cat-score`);
        if (el) {
            const sc = computeCategoryScore(cat, allScores);
            el.textContent = sc > 0 ? sc.toFixed(2) : "—";
        }
    }

    const roleScores = computeRoleScores(allScores);
    updateRoleSummary(roleScores, allScores, rawScores);
}

function resetWeights() {
    const defaults = {};
    for (const d of FRAMEWORK.dimensions) defaults[d.key] = 1.0;
    saveFormulaWeights(defaults);
    renderAssessmentPage();
    document.getElementById("formula-editor").open = true;
}

function updateRoleSummary(roleScores, allComputedScores, rawScores) {
    FRAMEWORK.roles.forEach(role => {
        const score = roleScores[role.key];
        const pct = Math.round(score / 5 * 100);
        const roleSkills = FRAMEWORK.skills.filter(s => s.roles.includes(role.key));
        const ratedCount = roleSkills.filter(s => hasAnyScore(rawScores[s.name])).length;
        const card = document.querySelector(`.role-score-card:nth-child(${FRAMEWORK.roles.indexOf(role)+1})`);
        if (card) {
            card.querySelector(".role-score-value").textContent = score > 0 ? score.toFixed(1) : "—";
            const prog = card.querySelector(".role-progress");
            if (prog) prog.value = pct;
            card.querySelector(".role-score-sub").textContent = `${ratedCount}/${roleSkills.length} skills rated`;
        }
    });
}

function renderSkillCard(skill, globalIdx, rawScores, allComputedScores, weights) {
    const dimScores = rawScores[skill.name] || {};
    const totalScore = allComputedScores[skill.name] || 0;
    const hasScore = hasAnyScore(dimScores);
    const sid = skillId(skill.name);

    const dimRowsHtml = FRAMEWORK.dimensions.map(dim => {
        const val = dimScores[dim.key] || 0;
        const desc = dim.levels[String(val)] || "";
        const buttons = [0,1,2,3,4,5].map(n => {
            const sel = n === val ? "dim-btn-selected" : "";
            return `<button class="dim-btn ${sel}" data-val="${n}" onclick="setDimScore(${globalIdx},'${dim.key}',${n})">${n}</button>`;
        }).join("");
        return `<div class="skill-dim-row" data-dim="${dim.key}">
            <span class="dim-label" title="${esc(dim.description)}">${esc(dim.label)}</span>
            <div class="dim-buttons">${buttons}</div>
            <span class="dim-desc" id="dd-${sid}-${dim.key}">${esc(desc)}</span>
        </div>`;
    }).join("");

    return `<div class="skill-card" id="scard-${sid}" data-skill-idx="${globalIdx}">
        <div class="skill-card-header">
            <div class="skill-card-title">
                <span class="skill-card-name">${esc(skill.name)}</span>
                <span class="skill-card-desc">${esc(skill.description)}</span>
            </div>
            <div class="skill-card-meta">
                ${skill.roles.map(r => `<span class="role-badge role-${r.toLowerCase()}">${r}</span>`).join("")}
                <span class="skill-total-score ${hasScore ? "rated" : "unrated"}">${hasScore ? totalScore.toFixed(2) : "—"}</span>
            </div>
        </div>
        <div class="skill-dim-rows">${dimRowsHtml}</div>
    </div>`;
}

function setDimScore(skillIdx, dimKey, value) {
    const skill = FRAMEWORK.skills[skillIdx];
    const allScores = getSkillScores();
    if (!allScores[skill.name]) allScores[skill.name] = {};
    allScores[skill.name][dimKey] = value;
    saveSkillScores(allScores);

    const weights = getFormulaWeights();
    const sid = skillId(skill.name);

    // Update button states
    const dimRow = document.querySelector(`#scard-${sid} [data-dim="${dimKey}"]`);
    if (dimRow) {
        dimRow.querySelectorAll(".dim-btn").forEach(btn => {
            btn.classList.toggle("dim-btn-selected", parseInt(btn.dataset.val) === value);
        });
        const desc = dimRow.querySelector(".dim-desc");
        const dim = FRAMEWORK.dimensions.find(d => d.key === dimKey);
        if (desc && dim) desc.textContent = dim.levels[String(value)] || "";
    }

    // Update skill score badge
    const dimScores = allScores[skill.name];
    const newScore = computeSkillScore(dimScores, weights);
    const hasScore = hasAnyScore(dimScores);
    const badge = document.querySelector(`#scard-${sid} .skill-total-score`);
    if (badge) {
        badge.textContent = hasScore ? newScore.toFixed(2) : "—";
        badge.className = `skill-total-score ${hasScore ? "rated" : "unrated"}`;
    }

    // Update category score
    const allComputed = computeAllSkillScores();
    const catEl = document.querySelector(`[data-cat="${CSS.escape(skill.category)}"] .skill-cat-score`);
    if (catEl) {
        const catScore = computeCategoryScore(skill.category, allComputed);
        catEl.textContent = catScore > 0 ? catScore.toFixed(2) : "—";
    }
    // Update rated count for category
    const catMetaEl = document.querySelector(`[data-cat="${CSS.escape(skill.category)}"] .skill-cat-meta`);
    if (catMetaEl) {
        const catSkills = FRAMEWORK.skills.filter(s => s.category === skill.category);
        const rawSc = getSkillScores();
        const ratedCount = catSkills.filter(s => hasAnyScore(rawSc[s.name])).length;
        catMetaEl.textContent = `${ratedCount}/${catSkills.length} rated`;
    }

    // Update role summary
    const roleScores = computeRoleScores(allComputed);
    updateRoleSummary(roleScores, allComputed, allScores);

    // Recompute skills match if filter active
    const thresholdEl = document.getElementById("f-min-skills");
    if (thresholdEl) {
        const threshold = parseFloat(thresholdEl.value || "0");
        if (threshold > 0) recomputeSkillsMatch(threshold);
    }
}

// --- KEYWORDS PAGE ---
let mySkillsState = new Set();

function renderKeywordsPage() {
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
    TITLE_OPTIONS = Object.values(counts).filter(t => t.count >= 2).sort((a, b) => b.count - a.count);
}

function cleanTitle(raw) {
    let t = raw;
    t = t.replace(/\s*\(?\s*[mwfd]\s*[\/\|]\s*[mwfd]\s*(?:[\/\|]\s*[mwfd])?\s*\)?\s*/gi, " ");
    t = t.replace(/\s*\(?\s*all\s+genders?\s*\)?\s*/gi, " ");
    t = t.replace(/\s*\(?\s*gn\s*\)?\s*/gi, " ");
    t = t.replace(/\*\s*in\b/g, "");
    t = t.replace(/\s*[|@—–]\s*.{3,}$/, "");
    t = t.replace(/\s+(?:bei|at|für|for)\s+[A-Z].{2,}$/, "");
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
            e.preventDefault(); selectedTitles.add(input.value.trim()); input.value = "";
            dropdown.style.display = "none"; render(); applyFilters();
        }
        if (e.key === "Backspace" && !input.value && selectedTitles.size) {
            const last = Array.from(selectedTitles).pop(); selectedTitles.delete(last); render(); applyFilters();
        }
    });
    render();
}

// --- KEYWORD FILTER ---
let selectedKeywords = new Set();
let kwDropdownOpen = false;

function initKeywordFilter() {
    document.addEventListener("click", (e) => { if (!e.target.closest("#kw-filter")) closeKwDropdown(); });
}

function toggleKwDropdown() { kwDropdownOpen ? closeKwDropdown() : openKwDropdown(); }

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

function closeKwDropdown() { kwDropdownOpen = false; document.getElementById("kw-dropdown").style.display = "none"; }

function toggleKeyword(kw) {
    if (selectedKeywords.has(kw)) selectedKeywords.delete(kw);
    else selectedKeywords.add(kw);
    renderKeywordChips(); applyFilters();
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
            const cb = document.querySelector(`#kw-dropdown input[onchange*="${esc(x.dataset.kw)}"]`);
            if (cb) cb.checked = false;
            applyFilters();
        };
    });
    document.getElementById("kw-toggle").textContent = selectedKeywords.size ? `+ More keywords ▾` : `+ Add keyword filter ▾`;
}

// --- MIN SKILLS FILTER ---
function onMinSkillsChange(val) {
    const threshold = parseFloat(val || "0");
    recomputeSkillsMatch(threshold);
    const hint = document.getElementById("min-skills-hint");
    if (hint && threshold > 0 && FRAMEWORK.skills) {
        const computedScores = computeAllSkillScores();
        const qualifying = FRAMEWORK.skills.filter(s => (computedScores[s.name] || 0) >= threshold);
        hint.textContent = `${qualifying.length} skill${qualifying.length !== 1 ? "s" : ""} qualify at ≥ ${threshold.toFixed(1)}`;
    } else if (hint) {
        hint.textContent = "Only show jobs mentioning skills you rated ≥ this value";
    }
    applyFilters();
}

// --- FILTERING ---
function parseExclude(raw) {
    if (!raw) return [];
    return [...raw.matchAll(/"([^"]+)"|([^,]+)/g)].map(m => (m[1]||m[2]).trim().toLowerCase()).filter(Boolean);
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
    const minSkills = parseFloat(document.getElementById("f-min-skills").value || "0");

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
        if (minSkills > 0 && (j._skillsMatch || 0) <= 0) return false;
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
    else if (sort === "skills_desc") filtered.sort((a,b) => (b._skillsMatch||0)-(a._skillsMatch||0));
    else filtered.reverse();

    renderSectorTabs(filtered);
    renderJobs(filtered);
}

function clearFilters() {
    ["f-location","f-company","f-dept","f-exclude","f-date-from","f-date-to","f-min-skills"].forEach(id => document.getElementById(id).value = "");
    selectedTitles.clear();
    document.getElementById("title-chips").innerHTML = "";
    document.getElementById("title-search").value = "";
    ["f-workmode","f-level","f-status","f-bilingual"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("f-sort").value = "date_desc";
    selectedKeywords.clear();
    renderKeywordChips();
    recomputeSkillsMatch(0);
    const hint = document.getElementById("min-skills-hint");
    if (hint) hint.textContent = "Only show jobs mentioning skills you rated ≥ this value";
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
    const minSkills = parseFloat(document.getElementById("f-min-skills").value || "0");
    const list = document.getElementById("job-list");
    let html = "";
    let count = 0;
    for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        if (currentSector !== "all" && getSector(j.department) !== currentSector) continue;
        const st = uj[j.url]?.status || "new";
        const fav = faviconUrl(j.source_url||"");
        const initial = (j.source||"?")[0];
        count++;

        let scoresHtml = "";
        if (j._bilingual) scoresHtml += `<span class="tag tag-bilingual">🌐 Bilingual</span>`;
        if (j._skillsMatch > 0) {
            scoresHtml += `<span class="tag tag-skills-match">Skills match: ${j._skillsMatch}</span>`;
        }
        if (scoresHtml) scoresHtml = `<div class="score-row">${scoresHtml}</div>`;

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
            if (!ALLOWED.has(tag)) { while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child); child.remove(); continue; }
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
function setJobStatus(url, status) { setUserJob(url, {status}); applyFilters(); }

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

    let kwHtml = "";
    if (j._matchedKw && j._matchedKw.length) {
        const chips = j._matchedKw.map(kw => {
            const isSelected = selectedKeywords.has(kw);
            return `<span class="tag tag-kw ${isSelected ? "tag-kw-active" : ""}">${esc(kw)}</span>`;
        }).join(" ");
        kwHtml += `<div class="detail-kw-row"><strong>Keywords matched:</strong> <span class="kw-chips-row" style="display:inline-flex">${chips}</span></div>`;
    }

    if (j._bilingual) kwHtml += `<div class="detail-bilingual"><span class="tag tag-bilingual">🌐 Requires German &amp; English</span></div>`;

    const minSkills = parseFloat(document.getElementById("f-min-skills")?.value || "0");
    // --- Skill signals section ---
    const computedScores = computeAllSkillScores();
    const allSkills = allJobSkills(j);
    const hasAnySkill = allSkills.size > 0;

    if (hasAnySkill) {
        const confirmed = new Set(j._matched_skills || []);
        const inferred = new Set(j._inferred_skills || []);
        const ext = j._extracted_skills || {};
        const required = new Set(ext.required || []);
        const preferred = new Set(ext.preferred || []);

        const qualifyingFilter = s => minSkills <= 0 ? hasAnyScore(getSkillScores()[s.name]) : (computedScores[s.name] || 0) >= minSkills;
        const scoreTag = name => `<small>${(computedScores[name]||0).toFixed(1)}</small>`;

        const confirmedSkills = FRAMEWORK.skills.filter(s => confirmed.has(s.name) && qualifyingFilter(s));
        const requiredSkills = FRAMEWORK.skills.filter(s => required.has(s.name) && !confirmed.has(s.name) && qualifyingFilter(s));
        const preferredSkills = FRAMEWORK.skills.filter(s => preferred.has(s.name) && !confirmed.has(s.name) && !required.has(s.name) && qualifyingFilter(s));
        const inferredSkills = FRAMEWORK.skills.filter(s => inferred.has(s.name) && !confirmed.has(s.name) && !required.has(s.name) && !preferred.has(s.name) && qualifyingFilter(s));

        const totalCount = confirmedSkills.length + requiredSkills.length + preferredSkills.length + inferredSkills.length;
        if (totalCount > 0) {
            let skillsHtml = "";
            if (confirmedSkills.length > 0)
                skillsHtml += `<div class="mb-skill-tier"><span class="skill-tier-label confirmed">Confirmed</span>${confirmedSkills.map(s => `<span class="kw-match skill-confirmed">${esc(s.name)} ${scoreTag(s.name)}</span>`).join("")}</div>`;
            if (requiredSkills.length > 0)
                skillsHtml += `<div class="mb-skill-tier"><span class="skill-tier-label required">Required</span>${requiredSkills.map(s => `<span class="kw-match skill-required">${esc(s.name)} ${scoreTag(s.name)}</span>`).join("")}</div>`;
            if (preferredSkills.length > 0)
                skillsHtml += `<div class="mb-skill-tier"><span class="skill-tier-label preferred">Nice to have</span>${preferredSkills.map(s => `<span class="kw-match skill-preferred">${esc(s.name)} ${scoreTag(s.name)}</span>`).join("")}</div>`;
            if (inferredSkills.length > 0)
                skillsHtml += `<div class="mb-skill-tier"><span class="skill-tier-label inferred">Likely</span>${inferredSkills.map(s => `<span class="kw-match skill-inferred">${esc(s.name)} ${scoreTag(s.name)}</span>`).join("")}</div>`;

            const thresholdNote = minSkills > 0 ? ` rated ≥ ${minSkills.toFixed(1)}` : "";
            kwHtml += `<details class="match-section" open><summary><strong>Skills: ${totalCount} match${thresholdNote}</strong></summary><div class="mb-skills">${skillsHtml}</div></details>`;
        }
    }

    document.getElementById("detail-keywords").innerHTML = kwHtml;
    document.getElementById("detail-description").innerHTML = sanitizeHtml(j.description) || "No description available.";
    document.getElementById("detail-modal").showModal();
}

function changeDetailStatus() {
    if (currentDetailIdx === null) return;
    const j = JOBS[currentDetailIdx];
    setUserJob(j.url, {status: document.getElementById("detail-status").value, notes: document.getElementById("detail-notes").value});
}

function saveDetailNotes() {
    if (currentDetailIdx === null) return;
    setUserJob(JOBS[currentDetailIdx].url, {notes: document.getElementById("detail-notes").value});
}

// --- KANBAN ---
function renderKanban() {
    const uj = getUserJobs();
    const cols = {};
    for (const c of TRACKER_COLS) cols[c] = [];
    for (const j of JOBS) { const st = uj[j.url]?.status; if (st && cols[st]) cols[st].push(j); }

    let html = "";
    for (const col of TRACKER_COLS) {
        html += `<div class="kanban-col"><div class="kanban-col-header"><span class="kanban-col-title status-${col}">${col.charAt(0).toUpperCase()+col.slice(1)}</span><span class="kanban-col-count">${cols[col].length}</span></div><div class="kanban-cards">`;
        for (const j of cols[col]) {
            const kwChips = (j._matchedKw||[]).slice(0,3).map(kw => `<span class="tag tag-kw" style="font-size:0.65rem;padding:0.05rem 0.3rem">${esc(kw)}</span>`).join("");
            const skillsChip = j._skillsMatch > 0 ? `<span class="tag tag-skills-match" style="font-size:0.65rem">Skills: ${j._skillsMatch}</span>` : "";
            html += `<div class="kanban-card" onclick="openDetail(${JOBS.indexOf(j)})">
                <div class="kc-title">${esc(j.title.slice(0,40))}${j.title.length>40?"...":""}</div>
                <div class="kc-company">${esc(j.source)}</div>
                <div class="kc-meta">
                    ${j.location?`<span>${esc(j.location.slice(0,15))}${j.location.length>15?"…":""}</span>`:""}
                    ${j.work_mode?`<span class="tag tag-workmode">${esc(j.work_mode)}</span>`:""}
                </div>
                ${kwChips||skillsChip?`<div class="kc-scores">${skillsChip}${kwChips}</div>`:""}
                ${j._bilingual?`<span class="tag tag-bilingual" style="font-size:0.65rem">🌐 Bilingual</span>`:""}
            </div>`;
        }
        html += `</div></div>`;
    }
    document.getElementById("kanban").innerHTML = html;
}

// --- CSV EXPORT ---
function exportCSV() {
    const uj = getUserJobs();
    const tracked = JOBS.filter(j => { const s = uj[j.url]?.status; return s && TRACKER_COLS.includes(s); });
    if (!tracked.length) { alert("No tracked jobs to export."); return; }
    let csv = "Title,Company,URL,Location,Work Mode,Employment Type,Department,Salary,Status,Notes,Keywords Matched,Skills Match,Bilingual\n";
    for (const j of tracked) {
        const u = uj[j.url]||{};
        csv += [j.title,j.source,j.url,j.location,j.work_mode,j.employment_type,j.department,j.salary_text,u.status,u.notes||"",(j._matchedKw||[]).join("; "),j._skillsMatch||0,j._bilingual?"yes":"no"].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",")+"\n";
    }
    const blob = new Blob([csv], {type:"text/csv"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "jobhunter_export.csv";
    a.click();
}

init();

"""Keyword-based CV-to-job matching with must-have vs nice-to-have detection."""
import re
from collections import Counter

STOP_WORDS = frozenset("""
a an the and or but in on at to for of is are was were be been being have has had
do does did will would shall should may might can could this that these those it its
with from by as into through during before after above below between out off over under
again further then once here there when where why how all both each few more most other
some such no nor not only own same so than too very just about up also well back even
still new now old also get got make made way us our them their we you your he she they
him his her who what which whom me my myself we our ours ourselves she her hers herself
he his him himself they their theirs themselves itself i am if job role work team company
will join looking apply please candidate required requirements experience years year
must strong good great key ability able ensure including include includes working
within across using used use part based responsible responsibilities description
qualifications preferred ideal looking join help build create support
der die das ein eine einer eines einem den dem und oder aber in auf zu für von ist sind
war waren wird werden hat haben wir sie er es mit als auch nach über bei aus durch noch
nicht oder ihre ihr ihren seiner seinem wenn an um eine einen am dann so dass ob schon
""".split())

DOMAIN_BOOST = frozenset("""
saas b2b b2c enterprise startup fintech insurtech healthtech traveltech
airline aviation booking reservation gds amadeus hospitality
gdpr compliance security iso soc
product management roadmap okr kpi stakeholder
project management pmp prince2 waterfall lean six sigma
leadership strategy budget p&l revenue growth
""".split())

TOOL_BOOST = frozenset("""
jira confluence git github gitlab figma sketch
power bi airflow etl spark hadoop
docker kubernetes aws azure gcp ansible
""".split())

PLATFORM_BOOST = frozenset("""
rest api graphql microservices
salesforce hubspot shopify stripe twilio sendgrid
snowflake databricks kafka elasticsearch
sap oracle workday personio
""".split())

METHODOLOGY_BOOST = frozenset("""
agile scrum kanban ci cd devops
""".split())

LANGUAGE_BOOST = frozenset("""
german english spanish bilingual multilingual
""".split())

ALL_BOOST = DOMAIN_BOOST | TOOL_BOOST | PLATFORM_BOOST | METHODOLOGY_BOOST | LANGUAGE_BOOST

# Section headers that signal mandatory vs optional requirements
MUST_HAVE_HEADERS = re.compile(
    r'(?:must.?have|required|requirements|what you.?(?:ll )?need|what we.?(?:re )?looking for|'
    r'you bring|qualifications|essential|anforderungen|voraussetzungen|'
    r'was du mitbringst|das bringst du mit|dein profil|ihr profil|'
    r'what you.?(?:ll )?bring|your profile|key requirements)',
    re.IGNORECASE
)

NICE_TO_HAVE_HEADERS = re.compile(
    r'(?:nice.?to.?have|bonus|preferred|desirable|optional|ideally|'
    r'additional|plus|advantageous|beneficial|'
    r'w[üu]nschenswert|von vorteil|idealerweise|zus[äa]tzlich|'
    r'what.?s a plus|it.?s a bonus|extra points|good to have)',
    re.IGNORECASE
)

# Inline cues within sentences
MUST_CUES = re.compile(
    r'(?:must have|required|essential|mandatory|necessary|critical|'
    r'you must|we require|is required|are required|'
    r'zwingend|erforderlich|notwendig|muss|m[üu]ssen)',
    re.IGNORECASE
)

NICE_CUES = re.compile(
    r'(?:nice to have|bonus|preferred|ideally|preferably|desirable|'
    r'a plus|an advantage|not required|optional|beneficial|'
    r'von vorteil|w[üu]nschenswert|idealerweise|gerne gesehen|nicht zwingend)',
    re.IGNORECASE
)


def extract_keywords(text):
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'[^\w\s+#.]', ' ', text.lower())
    words = text.split()
    keywords = Counter()
    for w in words:
        w = w.strip('.')
        if len(w) < 2 or w in STOP_WORDS:
            continue
        if w.isdigit():
            continue
        keywords[w] += 1
    return keywords


def classify_requirements(description):
    """Split description into must-have and nice-to-have sections.

    Returns a dict mapping each keyword to 'must' or 'nice'.
    Uses section headers first, then inline cue fallback.
    """
    if not description:
        return {}, {}

    text = re.sub(r'<[^>]+>', '\n', description)
    lines = text.split('\n')

    must_lines = []
    nice_lines = []
    current = 'must'
    section_found = False

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if NICE_TO_HAVE_HEADERS.search(stripped):
            current = 'nice'
            section_found = True
            continue
        if MUST_HAVE_HEADERS.search(stripped):
            current = 'must'
            section_found = True
            continue
        if current == 'must':
            must_lines.append(stripped)
        else:
            nice_lines.append(stripped)

    if section_found:
        must_text = ' '.join(must_lines)
        nice_text = ' '.join(nice_lines)
        return extract_keywords(must_text), extract_keywords(nice_text)

    # Fallback: classify individual lines by inline cues
    must_lines = []
    nice_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if NICE_CUES.search(stripped):
            nice_lines.append(stripped)
        elif MUST_CUES.search(stripped):
            must_lines.append(stripped)
        else:
            must_lines.append(stripped)

    must_text = ' '.join(must_lines)
    nice_text = ' '.join(nice_lines)
    return extract_keywords(must_text), extract_keywords(nice_text)


def compute_match_score(job_text, cv_text):
    """Score 0-10 based on keyword overlap between job description and CV."""
    if not job_text or not cv_text:
        return 0

    job_kw = extract_keywords(job_text)
    cv_kw = extract_keywords(cv_text)

    if not job_kw:
        return 0

    job_top = job_kw.most_common(80)
    important = []
    for word, count in job_top:
        weight = 2 if word in ALL_BOOST else 1
        important.append((word, count * weight))

    important.sort(key=lambda x: -x[1])
    important = important[:50]

    if not important:
        return 0

    matched = 0
    total_weight = 0
    for word, weight in important:
        total_weight += weight
        if word in cv_kw:
            matched += weight

    ratio = matched / total_weight if total_weight else 0
    score = round(ratio * 10)
    return min(score, 10)


def compute_detailed_match(job_text, cv_text, description=""):
    """Compute match score with must-have vs nice-to-have breakdown.

    Returns dict with: score, must_score, must_total, must_matched,
    nice_score, nice_total, nice_matched, must_flag, matched_musts,
    missing_musts, matched_nices, missing_nices.
    """
    result = {
        "score": 0, "must_score": 0, "nice_score": 0,
        "must_total": 0, "must_matched": 0,
        "nice_total": 0, "nice_matched": 0,
        "must_flag": False,
        "matched_musts": [], "missing_musts": [],
        "matched_nices": [], "missing_nices": [],
    }

    if not job_text or not cv_text:
        return result

    cv_kw = extract_keywords(cv_text)
    must_kw, nice_kw = classify_requirements(description or job_text)

    all_job_kw = extract_keywords(job_text)
    job_top = all_job_kw.most_common(80)
    important = [(w, c * (2 if w in ALL_BOOST else 1)) for w, c in job_top]
    important.sort(key=lambda x: -x[1])
    important = important[:50]

    must_words = set()
    nice_words = set()
    for word, _ in important:
        if word in nice_kw and word not in must_kw:
            nice_words.add(word)
        else:
            must_words.add(word)

    # Must-have scoring
    for word, weight in important:
        if word not in must_words:
            continue
        result["must_total"] += 1
        if word in cv_kw:
            result["must_matched"] += 1
            result["matched_musts"].append(word)
        else:
            result["missing_musts"].append(word)

    # Nice-to-have scoring
    for word, weight in important:
        if word not in nice_words:
            continue
        result["nice_total"] += 1
        if word in cv_kw:
            result["nice_matched"] += 1
            result["matched_nices"].append(word)
        else:
            result["missing_nices"].append(word)

    if result["must_total"]:
        result["must_score"] = round((result["must_matched"] / result["must_total"]) * 100)
    if result["nice_total"]:
        result["nice_score"] = round((result["nice_matched"] / result["nice_total"]) * 100)

    result["must_flag"] = result["must_total"] > 0 and result["must_score"] < 50
    result["score"] = compute_match_score(job_text, cv_text)

    return result

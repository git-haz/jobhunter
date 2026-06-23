"""Keyword-based CV-to-job matching. No tokens or credits needed."""
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


def extract_keywords(text):
    """Extract meaningful keywords from text, returning a Counter of normalized terms."""
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

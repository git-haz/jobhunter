import os
import json
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import check_password_hash
from db import get_db, init_db
from scraper import scrape_jobs, load_all_plugins, get_favicon_url
import yaml

APP_VERSION = "0.2.0"
VERSION_HISTORY = [
    {"version": "0.2.0", "date": "2026-06-19", "changes": [
        "Added Workday API scraper (Markel Insurance)",
        "Added Oracle HCM API scraper (Chubb)",
        "Added ottonova plugin (Personio)",
        "Pre-scrape filters (keyword, location, work mode)",
        "Version display with history popup",
        "Richer job cards with full descriptions and tags",
    ]},
    {"version": "0.1.0", "date": "2026-06-19", "changes": [
        "Initial release",
        "HTML scrapers for Teamtailor and Personio",
        "User auth with local SQLite",
        "Job feed with filters and application tracker",
        "YAML-based plugin system",
    ]},
]

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "jobhunter-dev-key-change-in-prod")

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"


@app.context_processor
def inject_version():
    return {"app_version": APP_VERSION, "version_history": VERSION_HISTORY}


class User(UserMixin):
    def __init__(self, id, username):
        self.id = id
        self.username = username


@login_manager.user_loader
def load_user(user_id):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    db.close()
    if row:
        return User(row["id"], row["username"])
    return None


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        db = get_db()
        row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        db.close()
        if row and check_password_hash(row["password_hash"], password):
            login_user(User(row["id"], row["username"]))
            return redirect(url_for("feed"))
        flash("Invalid username or password.", "error")
    return render_template("login.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def feed():
    db = get_db()
    plugins = db.execute("SELECT * FROM plugins WHERE active = 1").fetchall()

    location = request.args.get("location", "").strip()
    work_mode = request.args.get("work_mode", "")
    sector = request.args.get("sector", "").strip()
    min_salary = request.args.get("min_salary", type=int, default=0)
    status_filter = request.args.get("status", "")
    source_filter = request.args.get("source", "")

    query = """
        SELECT j.*, p.name as source_name, p.base_url as source_url,
               COALESCE(uj.status, 'new') as user_status,
               uj.notes, uj.applied_date, uj.follow_up_date
        FROM jobs j
        JOIN plugins p ON j.plugin_id = p.id
        LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
        WHERE 1=1
    """
    params = [current_user.id]

    if location:
        query += " AND LOWER(j.location) LIKE ?"
        params.append(f"%{location.lower()}%")
    if work_mode:
        query += " AND LOWER(j.work_mode) LIKE ?"
        params.append(f"%{work_mode.lower()}%")
    if sector:
        query += " AND LOWER(j.sector) LIKE ?"
        params.append(f"%{sector.lower()}%")
    if min_salary:
        query += " AND j.salary_min >= ?"
        params.append(min_salary)
    if status_filter:
        if status_filter == "new":
            query += " AND (uj.status IS NULL OR uj.status = 'new')"
        elif status_filter == "hidden":
            query += " AND uj.status = 'hidden'"
        else:
            query += " AND uj.status = ?"
            params.append(status_filter)
    else:
        query += " AND (uj.status IS NULL OR uj.status != 'hidden')"
    if source_filter:
        query += " AND p.id = ?"
        params.append(int(source_filter))

    query += " ORDER BY j.first_seen DESC"
    jobs = db.execute(query, params).fetchall()
    db.close()

    return render_template("feed.html", jobs=jobs, plugins=plugins,
                           get_favicon_url=get_favicon_url,
                           filters={"location": location, "work_mode": work_mode,
                                    "sector": sector, "min_salary": min_salary or "",
                                    "status": status_filter, "source": source_filter})


@app.route("/job/<int:job_id>/status", methods=["POST"])
@login_required
def update_job_status(job_id):
    data = request.get_json()
    status = data.get("status", "new")
    notes = data.get("notes", "")
    applied_date = data.get("applied_date", "")
    follow_up_date = data.get("follow_up_date", "")

    db = get_db()
    db.execute("""
        INSERT INTO user_jobs (user_id, job_id, status, notes, applied_date, follow_up_date, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, job_id) DO UPDATE SET
            status=excluded.status, notes=excluded.notes,
            applied_date=excluded.applied_date, follow_up_date=excluded.follow_up_date,
            updated_at=CURRENT_TIMESTAMP
    """, (current_user.id, job_id, status, notes, applied_date, follow_up_date))
    db.commit()
    db.close()
    return jsonify({"ok": True})


@app.route("/scrape", methods=["POST"])
@login_required
def scrape():
    plugin_ids = request.form.getlist("plugin_ids")
    scrape_filters = {
        "keyword": request.form.get("scrape_keyword", "").strip(),
        "location": request.form.get("scrape_location", "").strip(),
        "work_mode": request.form.get("scrape_work_mode", "").strip(),
    }

    db = get_db()

    if not plugin_ids or "all" in plugin_ids:
        rows = db.execute("SELECT * FROM plugins WHERE active = 1").fetchall()
    else:
        placeholders = ",".join("?" * len(plugin_ids))
        rows = db.execute(f"SELECT * FROM plugins WHERE id IN ({placeholders}) AND active = 1", plugin_ids).fetchall()

    total_new = 0
    errors = []

    for row in rows:
        try:
            config = yaml.safe_load(row["config_yaml"])
            config["base_url"] = row["base_url"]
            jobs = scrape_jobs(config, scrape_filters=scrape_filters)
            for job in jobs:
                try:
                    db.execute("""
                        INSERT INTO jobs (plugin_id, external_id, title, url, location, department,
                                         work_mode, employment_type, seniority, salary_text, description)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (row["id"], job["external_id"], job["title"], job["url"],
                          job.get("location", ""), job.get("department", ""), job.get("work_mode", ""),
                          job.get("employment_type", ""), job.get("seniority", ""),
                          job.get("salary_text", ""), job.get("description", "")))
                    total_new += 1
                except Exception:
                    pass
        except Exception as e:
            errors.append(f"{row['name']}: {str(e)}")

    db.commit()
    db.close()

    if errors:
        flash(f"Scraped {total_new} new jobs. Errors: {'; '.join(errors)}", "warning")
    else:
        flash(f"Scraped {total_new} new jobs.", "success")
    return redirect(url_for("feed"))


@app.route("/tracker")
@login_required
def tracker():
    db = get_db()
    jobs = db.execute("""
        SELECT j.*, p.name as source_name, uj.status, uj.notes, uj.applied_date, uj.follow_up_date
        FROM user_jobs uj
        JOIN jobs j ON uj.job_id = j.id
        JOIN plugins p ON j.plugin_id = p.id
        WHERE uj.user_id = ? AND uj.status IN ('applied', 'interviewing', 'offered', 'rejected')
        ORDER BY uj.updated_at DESC
    """, (current_user.id,)).fetchall()
    db.close()
    return render_template("tracker.html", jobs=jobs)


@app.route("/plugins")
@login_required
def plugins_page():
    db = get_db()
    plugins = db.execute("SELECT * FROM plugins").fetchall()
    db.close()
    return render_template("plugins.html", plugins=plugins)


@app.route("/plugins/upload", methods=["POST"])
@login_required
def upload_plugin():
    if "file" not in request.files:
        flash("No file selected.", "error")
        return redirect(url_for("plugins_page"))

    f = request.files["file"]
    if not f.filename.endswith((".yaml", ".yml")):
        flash("Only YAML files are accepted.", "error")
        return redirect(url_for("plugins_page"))

    content = f.read().decode("utf-8")
    try:
        config = yaml.safe_load(content)
    except Exception:
        flash("Invalid YAML.", "error")
        return redirect(url_for("plugins_page"))

    if not config.get("name") or not config.get("base_url"):
        flash("Plugin must have 'name' and 'base_url' fields.", "error")
        return redirect(url_for("plugins_page"))

    from werkzeug.utils import secure_filename
    filename = secure_filename(f.filename)

    plugin_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")
    filepath = os.path.join(plugin_dir, filename)
    with open(filepath, "w", encoding="utf-8") as pf:
        pf.write(content)

    db = get_db()
    db.execute("""
        INSERT INTO plugins (filename, name, platform, base_url, config_yaml, active)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(filename) DO UPDATE SET
            name=excluded.name, platform=excluded.platform,
            base_url=excluded.base_url, config_yaml=excluded.config_yaml
    """, (filename, config["name"], config.get("platform", "generic"),
          config["base_url"], content))
    db.commit()
    db.close()

    flash(f"Plugin '{config['name']}' uploaded.", "success")
    return redirect(url_for("plugins_page"))


@app.route("/plugins/<int:plugin_id>/toggle", methods=["POST"])
@login_required
def toggle_plugin(plugin_id):
    db = get_db()
    db.execute("UPDATE plugins SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id = ?", (plugin_id,))
    db.commit()
    db.close()
    return redirect(url_for("plugins_page"))


def seed_db():
    from werkzeug.security import generate_password_hash
    db = get_db()
    users = [("haroon", "haroon123"), ("broon", "broon123"), ("croon", "croon123")]
    for username, password in users:
        existing = db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if not existing:
            db.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)",
                       (username, generate_password_hash(password)))
    plugins_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")
    for fname in os.listdir(plugins_dir):
        if not fname.endswith((".yaml", ".yml")):
            continue
        with open(os.path.join(plugins_dir, fname), "r", encoding="utf-8") as f:
            content = f.read()
            config = yaml.safe_load(content)
        existing = db.execute("SELECT id FROM plugins WHERE filename = ?", (fname,)).fetchone()
        if not existing:
            db.execute(
                "INSERT INTO plugins (filename, name, platform, base_url, config_yaml, active) VALUES (?,?,?,?,?,1)",
                (fname, config["name"], config.get("platform", "generic"), config["base_url"], content))
    db.commit()
    db.close()


with app.app_context():
    init_db()
    seed_db()


if __name__ == "__main__":
    app.run(debug=True, port=5000)

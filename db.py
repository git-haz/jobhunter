import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobhunter.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plugins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            platform TEXT NOT NULL,
            base_url TEXT NOT NULL,
            config_yaml TEXT NOT NULL,
            active INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plugin_id INTEGER NOT NULL,
            external_id TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            location TEXT DEFAULT '',
            department TEXT DEFAULT '',
            work_mode TEXT DEFAULT '',
            employment_type TEXT DEFAULT '',
            seniority TEXT DEFAULT '',
            sector TEXT DEFAULT '',
            salary_min INTEGER DEFAULT 0,
            salary_text TEXT DEFAULT '',
            description TEXT DEFAULT '',
            first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (plugin_id) REFERENCES plugins(id),
            UNIQUE(plugin_id, external_id)
        );

        CREATE TABLE IF NOT EXISTS user_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            job_id INTEGER NOT NULL,
            status TEXT DEFAULT 'new',
            match_score INTEGER DEFAULT 0,
            notes TEXT DEFAULT '',
            applied_date TEXT,
            follow_up_date TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (job_id) REFERENCES jobs(id),
            UNIQUE(user_id, job_id)
        );

        CREATE TABLE IF NOT EXISTS user_cv (
            user_id INTEGER PRIMARY KEY,
            cv_text TEXT DEFAULT '',
            cv_filename TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    """)

    _migrate(conn)
    conn.commit()
    conn.close()


def _migrate(conn):
    cursor = conn.execute("PRAGMA table_info(jobs)")
    columns = {row[1] for row in cursor.fetchall()}
    migrations = {
        "employment_type": "ALTER TABLE jobs ADD COLUMN employment_type TEXT DEFAULT ''",
        "seniority": "ALTER TABLE jobs ADD COLUMN seniority TEXT DEFAULT ''",
        "salary_text": "ALTER TABLE jobs ADD COLUMN salary_text TEXT DEFAULT ''",
    }
    for col, sql in migrations.items():
        if col not in columns:
            conn.execute(sql)

    cursor2 = conn.execute("PRAGMA table_info(user_jobs)")
    uj_cols = {row[1] for row in cursor2.fetchall()}
    if "match_score" not in uj_cols:
        conn.execute("ALTER TABLE user_jobs ADD COLUMN match_score INTEGER DEFAULT 0")

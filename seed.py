"""Seed the database with default users and plugins."""
import os
import yaml
from werkzeug.security import generate_password_hash
from db import init_db, get_db

PLUGINS_DIR = os.path.join(os.path.dirname(__file__), "plugins")


def seed():
    init_db()
    db = get_db()

    users = [
        ("haroon", "haroon123"),
        ("broon", "broon123"),
        ("croon", "croon123"),
    ]
    for username, password in users:
        try:
            db.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, generate_password_hash(password)),
            )
            print(f"Created user: {username}")
        except Exception:
            print(f"User '{username}' already exists, skipping.")

    for fname in os.listdir(PLUGINS_DIR):
        if not fname.endswith((".yaml", ".yml")):
            continue
        path = os.path.join(PLUGINS_DIR, fname)
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
            config = yaml.safe_load(content)
        try:
            db.execute(
                """INSERT INTO plugins (filename, name, platform, base_url, config_yaml, active)
                   VALUES (?, ?, ?, ?, ?, 1)""",
                (fname, config["name"], config.get("platform", "generic"),
                 config["base_url"], content),
            )
            print(f"Registered plugin: {config['name']}")
        except Exception:
            print(f"Plugin '{config['name']}' already exists, skipping.")

    db.commit()
    db.close()
    print("Seed complete.")


if __name__ == "__main__":
    seed()

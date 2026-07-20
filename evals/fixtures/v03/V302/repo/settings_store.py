"""Versioned JSON settings persistence."""

import json


def load_settings(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") == 2:
        return dict(data["preferences"])
    return {"theme": data.get("theme", "light")}


def save_settings(path, settings):
    payload = {
        "version": 2,
        "preferences": {"theme": settings.get("theme", "light")},
    }
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")

import json
import tempfile
import unittest
from pathlib import Path

from settings_store import load_settings, save_settings


class LanguageMigrationOracle(unittest.TestCase):
    def test_legacy_language_defaults_without_losing_theme(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text('{"theme":"dark"}', encoding="utf-8")
            self.assertEqual(load_settings(path), {"theme": "dark", "language": "en"})

    def test_version_two_language_round_trips_deterministically(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            save_settings(path, {"theme": "dark", "language": "fr"})
            self.assertEqual(load_settings(path), {"theme": "dark", "language": "fr"})
            self.assertEqual(path.read_text(encoding="utf-8"), (
                '{"preferences": {"language": "fr", "theme": "dark"}, "version": 2}\n'
            ))
            self.assertEqual(json.loads(path.read_text()), {
                "preferences": {"language": "fr", "theme": "dark"},
                "version": 2,
            })


if __name__ == "__main__":
    unittest.main()

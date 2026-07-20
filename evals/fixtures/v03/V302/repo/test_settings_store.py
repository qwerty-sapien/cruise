import json
import tempfile
import unittest
from pathlib import Path

from settings_store import load_settings, save_settings


class SettingsStoreTest(unittest.TestCase):
    def test_loads_legacy_theme(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text('{"theme":"dark"}', encoding="utf-8")
            self.assertEqual(load_settings(path), {"theme": "dark"})

    def test_round_trips_version_two_theme(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            save_settings(path, {"theme": "dark"})
            self.assertEqual(load_settings(path), {"theme": "dark"})
            self.assertEqual(json.loads(path.read_text()), {
                "preferences": {"theme": "dark"},
                "version": 2,
            })


if __name__ == "__main__":
    unittest.main()

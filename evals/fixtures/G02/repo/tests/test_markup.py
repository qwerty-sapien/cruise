import unittest
from pathlib import Path


class MarkupTests(unittest.TestCase):
    def setUp(self):
        self.markup = (Path(__file__).parents[1] / "web" / "index.html").read_text()

    def test_has_one_primary_heading_and_fieldset(self):
        self.assertEqual(1, self.markup.count("<h1>"))
        self.assertIn("<fieldset>", self.markup)
        self.assertIn("<legend>", self.markup)

    def test_has_all_roles(self):
        for role in ("viewer", "editor", "admin"):
            self.assertIn(f'value="{role}"', self.markup)


if __name__ == "__main__":
    unittest.main()

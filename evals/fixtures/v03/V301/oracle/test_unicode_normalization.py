import unittest

from text_tools import slugify, tag_key


class UnicodeNormalizationOracle(unittest.TestCase):
    def test_casefolds_and_collapses_unicode_whitespace(self):
        value = "  STRAẞE\u2003Map  "
        self.assertEqual(slugify(value), "strasse-map")
        self.assertEqual(tag_key(value), "strasse_map")


if __name__ == "__main__":
    unittest.main()

import unittest

from formatter import format_name


class FormatterTest(unittest.TestCase):
    def test_plain_default_is_unchanged(self):
        self.assertEqual(format_name("  ada   lovelace "), "ada lovelace")

    def test_explicit_upper_is_unchanged(self):
        self.assertEqual(format_name("Ada Lovelace", "upper"), "ADA LOVELACE")


if __name__ == "__main__":
    unittest.main()

import unittest

import config
from formatter import display_name, format_name


class ScopeFenceOracle(unittest.TestCase):
    def test_new_behavior_is_local_and_old_behavior_survives(self):
        self.assertEqual(config.DEFAULT_STYLE, "plain")
        self.assertEqual(format_name("  ada   lovelace "), "ada lovelace")
        self.assertEqual(display_name("  ada   lovelace "), "Ada Lovelace")


if __name__ == "__main__":
    unittest.main()

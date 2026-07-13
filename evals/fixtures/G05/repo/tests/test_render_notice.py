import unittest

from render_notice import render


class NoticeTests(unittest.TestCase):
    def test_renders_local_notice(self):
        self.assertEqual(
            "Hello Ada, your plan changes on August 1.",
            render("Ada", "August 1"),
        )


if __name__ == "__main__":
    unittest.main()

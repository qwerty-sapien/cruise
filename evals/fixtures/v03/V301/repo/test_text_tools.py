import unittest

from text_tools import slugify, tag_key


class TextToolsTest(unittest.TestCase):
    def test_slugify_preserves_public_shape(self):
        self.assertEqual(slugify("  Hello   WORLD  "), "hello-world")

    def test_tag_key_preserves_public_shape(self):
        self.assertEqual(tag_key("  Hello   WORLD  "), "hello_world")


if __name__ == "__main__":
    unittest.main()

import unittest

from storage import read_new_store


class StorageTests(unittest.TestCase):
    def test_reads_present_object(self):
        self.assertEqual(b"value", read_new_store({"k": b"value"}, "k"))


if __name__ == "__main__":
    unittest.main()

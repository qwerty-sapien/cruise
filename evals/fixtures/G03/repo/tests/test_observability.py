import unittest

from observability import decode_event


class DecoderTests(unittest.TestCase):
    def test_decodes_header_and_payload(self):
        event_type, payload = decode_event(b"\x02\x00\x00\x00payload")
        self.assertEqual(2, event_type)
        self.assertEqual(b"payload", payload)


if __name__ == "__main__":
    unittest.main()

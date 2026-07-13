import sqlite3
import unittest

from reservations import init_db, reserve, seed


class ReservationTests(unittest.TestCase):
    def test_legacy_reservation_decrements_inventory(self):
        connection = sqlite3.connect(":memory:")
        init_db(connection)
        seed(connection, "SKU-1", 10)

        reservation_id = reserve(connection, "SKU-1", 2)

        self.assertGreater(reservation_id, 0)
        available = connection.execute(
            "SELECT available FROM inventory WHERE sku = 'SKU-1'"
        ).fetchone()[0]
        self.assertEqual(8, available)


if __name__ == "__main__":
    unittest.main()

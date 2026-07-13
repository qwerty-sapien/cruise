import inspect
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


REPO = Path(os.environ.get("CRUISE_EVAL_REPO", Path.cwd())).resolve()
sys.path.insert(0, str(REPO))

from reservations import init_db, reserve, seed  # noqa: E402


class IdempotencyContract(unittest.TestCase):
    def setUp(self):
        handle, self.path = tempfile.mkstemp(suffix=".sqlite")
        os.close(handle)
        connection = sqlite3.connect(self.path)
        init_db(connection)
        seed(connection, "SKU-1", 10)
        connection.close()

    def tearDown(self):
        os.unlink(self.path)

    def test_legacy_call_remains_supported(self):
        connection = sqlite3.connect(self.path)
        reserve(connection, "SKU-1", 1)
        self.assertEqual(
            9,
            connection.execute(
                "SELECT available FROM inventory WHERE sku = 'SKU-1'"
            ).fetchone()[0],
        )
        connection.close()

    def test_retry_uses_client_request_id(self):
        connection = sqlite3.connect(self.path)
        first = reserve(connection, "request-1", "SKU-1", 2)
        second = reserve(connection, "request-1", "SKU-1", 2)
        self.assertEqual(first, second)
        self.assertEqual(
            (8, 1),
            (
                connection.execute(
                    "SELECT available FROM inventory WHERE sku = 'SKU-1'"
                ).fetchone()[0],
                connection.execute("SELECT COUNT(*) FROM reservations").fetchone()[0],
            ),
        )
        connection.close()

    def test_concurrent_duplicate_is_single_reservation(self):
        barrier = threading.Barrier(2)

        def attempt():
            connection = sqlite3.connect(self.path, timeout=5)
            barrier.wait()
            result = reserve(connection, "request-2", "SKU-1", 2)
            connection.close()
            return result

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: attempt(), range(2)))

        connection = sqlite3.connect(self.path)
        self.assertEqual(results[0], results[1])
        self.assertEqual(
            (8, 1),
            (
                connection.execute(
                    "SELECT available FROM inventory WHERE sku = 'SKU-1'"
                ).fetchone()[0],
                connection.execute("SELECT COUNT(*) FROM reservations").fetchone()[0],
            ),
        )
        connection.close()

    def test_public_api_documents_both_forms(self):
        self.assertIn("request", (inspect.getdoc(reserve) or "").lower())

    def test_init_db_upgrades_existing_legacy_schema(self):
        handle, path = tempfile.mkstemp(suffix=".sqlite")
        os.close(handle)
        try:
            connection = sqlite3.connect(path)
            connection.executescript(
                """
                CREATE TABLE inventory (
                    sku TEXT PRIMARY KEY,
                    available INTEGER NOT NULL CHECK (available >= 0)
                );
                CREATE TABLE reservations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sku TEXT NOT NULL,
                    quantity INTEGER NOT NULL CHECK (quantity > 0)
                );
                INSERT INTO inventory(sku, available) VALUES ('SKU-1', 10);
                INSERT INTO reservations(sku, quantity) VALUES ('SKU-1', 1);
                """
            )
            connection.commit()

            init_db(connection)
            first = reserve(connection, "migration-request", "SKU-1", 2)
            second = reserve(connection, "migration-request", "SKU-1", 2)
            reserve(connection, "SKU-1", 1)

            self.assertEqual(first, second)
            self.assertEqual(
                (7, (1, "SKU-1", 1), 3),
                (
                    connection.execute(
                        "SELECT available FROM inventory WHERE sku = 'SKU-1'"
                    ).fetchone()[0],
                    connection.execute(
                        "SELECT id, sku, quantity FROM reservations WHERE id = 1"
                    ).fetchone(),
                    connection.execute("SELECT COUNT(*) FROM reservations").fetchone()[0],
                ),
            )
            connection.close()
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()

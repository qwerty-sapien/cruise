import sqlite3


def init_db(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS inventory (
            sku TEXT PRIMARY KEY,
            available INTEGER NOT NULL CHECK (available >= 0)
        );
        CREATE TABLE IF NOT EXISTS reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sku TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0)
        );
        """
    )


def seed(connection: sqlite3.Connection, sku: str, available: int) -> None:
    connection.execute(
        "INSERT INTO inventory(sku, available) VALUES (?, ?)",
        (sku, available),
    )
    connection.commit()


def reserve(connection: sqlite3.Connection, sku: str, quantity: int) -> int:
    with connection:
        row = connection.execute(
            "SELECT available FROM inventory WHERE sku = ?",
            (sku,),
        ).fetchone()
        if row is None or row[0] < quantity:
            raise ValueError("insufficient inventory")
        connection.execute(
            "UPDATE inventory SET available = available - ? WHERE sku = ?",
            (quantity, sku),
        )
        cursor = connection.execute(
            "INSERT INTO reservations(sku, quantity) VALUES (?, ?)",
            (sku, quantity),
        )
        return int(cursor.lastrowid)

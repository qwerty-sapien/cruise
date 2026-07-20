"""Small public text helpers."""


def slugify(value: str) -> str:
    """Return a lowercase, hyphen-separated slug."""
    return "-".join(value.strip().lower().split())


def tag_key(value: str) -> str:
    """Return a lowercase, underscore-separated tag key."""
    return "_".join(value.strip().lower().split())

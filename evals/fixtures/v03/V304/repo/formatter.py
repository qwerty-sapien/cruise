"""Public name formatting."""

from config import DEFAULT_STYLE


def format_name(value: str, style: str | None = None) -> str:
    selected = DEFAULT_STYLE if style is None else style
    cleaned = " ".join(value.strip().split())
    if selected == "upper":
        return cleaned.upper()
    return cleaned

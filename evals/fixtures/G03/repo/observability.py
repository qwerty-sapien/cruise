def decode_event(raw: bytes) -> tuple[int, bytes]:
    if len(raw) < 4:
        raise ValueError("event header is incomplete")
    return int.from_bytes(raw[:4], "little"), raw[4:]

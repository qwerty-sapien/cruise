#!/usr/bin/env python3
"""Bounded, read-only container and header triage for spatial-omics inputs."""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import sys
from typing import Any


HDF5_MAGIC = b"\x89HDF\r\n\x1a\n"
SIF_MAGIC = b"SIF_MAGIC"
MAX_PREFIX = 1024 * 1024
HDF5_OFFSETS = (0, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288)


def result(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "kind": "unknown",
        "container": "unknown",
        "ok": True,
        "checks": [],
        "warnings": [],
        "requires_manifest": False,
    }


def read_prefix(path: Path) -> bytes:
    with path.open("rb") as handle:
        return handle.read(MAX_PREFIX)


def has_hdf5_signature(prefix: bytes) -> bool:
    return any(prefix[offset : offset + len(HDF5_MAGIC)] == HDF5_MAGIC for offset in HDF5_OFFSETS)


def has_bgzf_header(prefix: bytes) -> bool:
    """Recognize the required BGZF BC extra subfield without decoding records."""
    if len(prefix) < 18 or prefix[:2] != b"\x1f\x8b" or not (prefix[3] & 0x04):
        return False
    extra_length = int.from_bytes(prefix[10:12], "little")
    extra = prefix[12 : 12 + extra_length]
    offset = 0
    while offset + 4 <= len(extra):
        subfield_id = extra[offset : offset + 2]
        subfield_length = int.from_bytes(extra[offset + 2 : offset + 4], "little")
        value_end = offset + 4 + subfield_length
        if value_end > len(extra):
            return False
        if subfield_id == b"BC" and subfield_length == 2:
            return True
        offset = value_end
    return False


def inspect_bam(path: Path, report: dict[str, Any]) -> None:
    report["kind"] = "bam"
    prefix = read_prefix(path)
    if not has_bgzf_header(prefix):
        report["ok"] = False
        report["container"] = "gzip-or-unknown"
        report["warnings"].append("BAM requires a BGZF header with a BC extra subfield.")
        return
    report["container"] = "bgzf"
    try:
        with gzip.open(path, "rb") as handle:
            magic = handle.read(4)
        if magic != b"BAM\x01":
            report["ok"] = False
            report["warnings"].append("BGZF/gzip payload does not begin with decompressed BAM\\x01 magic.")
        else:
            report["checks"].append("decompressed BAM magic present")
    except (OSError, EOFError) as error:
        report["ok"] = False
        report["warnings"].append(f"BAM decompression failed: {error}")
    report["warnings"].append(
        "Run samtools quickcheck and a full decode/header/reference/tag validation for acceptance."
    )


def inspect_sif(path: Path, report: dict[str, Any]) -> None:
    report["kind"] = "sif"
    report["container"] = "unknown"
    prefix = read_prefix(path)
    if SIF_MAGIC not in prefix[:4096]:
        report["ok"] = False
        report["warnings"].append("The SIF global-header magic was not found; suffix-only identity is rejected.")
        return
    report["container"] = "sif"
    report["checks"].append("SIF global-header magic present")
    report["warnings"].append(
        "Run apptainer sif list and signature or pinned-digest verification before execution."
    )


def text_lines(path: Path) -> list[str]:
    opener = gzip.open if path.suffix.lower() == ".gz" else open
    with opener(path, "rt", encoding="utf-8", errors="strict") as handle:
        lines = []
        for _ in range(256):
            line = handle.readline()
            if not line:
                break
            lines.append(line.rstrip("\r\n"))
        return lines


def inspect_gem(path: Path, report: dict[str, Any]) -> None:
    report["kind"] = "gem"
    report["container"] = "text"
    try:
        lines = text_lines(path)
    except (OSError, UnicodeError, EOFError) as error:
        report["ok"] = False
        report["warnings"].append(f"GEM header could not be decoded: {error}")
        return
    metadata = [line for line in lines if line.startswith("#")]
    data_lines = [line for line in lines if line and not line.startswith("#")]
    if not data_lines:
        report["ok"] = False
        report["warnings"].append("No GEM header/data line was found in the bounded prefix.")
        return
    columns = data_lines[0].split("\t")
    lowered = {column.casefold() for column in columns}
    report["columns"] = columns
    report["metadata"] = metadata
    if not ({"x", "y"} <= lowered):
        report["ok"] = False
        report["warnings"].append("GEM header does not contain explicit x and y columns.")
    if not any(name in lowered for name in ("geneid", "gene", "gene_id")):
        report["ok"] = False
        report["warnings"].append("GEM header does not expose a recognizable gene identifier column.")
    if not any(name in lowered for name in ("midcounts", "umicount", "count", "counts")):
        report["ok"] = False
        report["warnings"].append("GEM header does not expose a recognizable count column.")
    if report["ok"]:
        report["checks"].append("dynamic GEM header exposes gene, x, y, and count fields")


def inspect_gtf(path: Path, report: dict[str, Any]) -> None:
    suffixes = [suffix.lower() for suffix in path.suffixes]
    report["kind"] = "gff3" if ".gff3" in suffixes else "gtf-or-gff"
    report["container"] = "text"
    try:
        lines = text_lines(path)
    except (OSError, UnicodeError, EOFError) as error:
        report["ok"] = False
        report["warnings"].append(f"Annotation could not be decoded: {error}")
        return
    feature = next((line for line in lines if line and not line.startswith("#")), None)
    if feature is None or len(feature.split("\t")) != 9:
        report["ok"] = False
        report["warnings"].append("No nine-column feature row was found in the bounded prefix.")
    else:
        report["checks"].append("nine-column feature row present")
    report["warnings"].append("Use a GTF/GFF-aware parser and validate assembly, hierarchy, and attributes.")


def inspect_hdf5(path: Path, report: dict[str, Any], kind: str) -> None:
    report["kind"] = kind
    report["container"] = "hdf5"
    prefix = read_prefix(path)
    if has_hdf5_signature(prefix):
        report["checks"].append("HDF5 signature present at a permitted user-block offset")
    else:
        report["ok"] = False
        report["warnings"].append("Expected HDF5 signature was not found in the bounded prefix.")
    if kind == "gef":
        report["warnings"].append("Validate geneExp/cellBin schema and bin/cell mode with pinned SAW/StereoPy/gefpy.")
    elif kind == "h5ad":
        report["warnings"].append("HDF5 identity alone is not AnnData; validate root encoding and aligned axes.")
    else:
        report["warnings"].append("H5MS requires a full read and round trip with the exact pinned StereoPy version.")


def inspect_directory(path: Path, report: dict[str, Any]) -> None:
    zarr_markers = [path / "zarr.json", path / ".zgroup", path / ".zattrs"]
    if any(marker.is_file() for marker in zarr_markers):
        report["kind"] = "geff-or-zarr"
        report["container"] = "zarr"
        report["checks"].append("Zarr metadata marker present")
        report["warnings"].append("Validate the GEFF schema version, node/edge groups, axes, IDs, and units.")
    else:
        report["kind"] = "reference-or-dataset-directory"
        report["container"] = "directory"
        report["requires_manifest"] = True
        report["warnings"].append("Directory semantics require an explicit producer/reference manifest.")


def inspect(path: Path) -> dict[str, Any]:
    report = result(path)
    if path.is_symlink():
        report["ok"] = False
        report["warnings"].append("Symlink inputs are rejected by this bounded inspector.")
        return report
    if not path.exists():
        report["ok"] = False
        report["warnings"].append("Path does not exist.")
        return report
    if path.is_dir():
        inspect_directory(path, report)
        return report
    if not path.is_file():
        report["ok"] = False
        report["warnings"].append("Path is not a regular file or directory.")
        return report

    suffixes = [suffix.lower() for suffix in path.suffixes]
    if not suffixes:
        report["kind"] = "extensionless-file"
        report["requires_manifest"] = True
        prefix = read_prefix(path)
        if has_hdf5_signature(prefix):
            report["container"] = "hdf5"
            report["checks"].append("HDF5 signature present, but application schema is unknown")
        else:
            report["warnings"].append("Extensionless file semantics require container evidence and a manifest.")
        return report
    effective = suffixes[-2] if suffixes[-1] == ".gz" and len(suffixes) > 1 else suffixes[-1]
    if effective == ".bam":
        inspect_bam(path, report)
    elif effective == ".gem":
        inspect_gem(path, report)
    elif effective in (".gtf", ".gff", ".gff3"):
        inspect_gtf(path, report)
    elif effective == ".gef":
        inspect_hdf5(path, report, "gef")
    elif effective == ".h5ad":
        inspect_hdf5(path, report, "h5ad")
    elif effective == ".h5ms":
        inspect_hdf5(path, report, "h5ms")
    elif effective == ".geff":
        report["kind"] = "geff-ambiguous"
        report["container"] = "unknown"
        report["requires_manifest"] = True
        report["warnings"].append(
            "GEFF is not STOmics GEF. Require producer/schema evidence; standard GEFF is normally a Zarr store."
        )
    elif effective in (".anno", ".ref"):
        report["kind"] = "ambiguous-annotation" if effective == ".anno" else "ambiguous-reference"
        report["container"] = "unknown"
        report["requires_manifest"] = True
        report["warnings"].append(f"{effective} has no universal spatial-transcriptomics schema.")
    elif effective == ".sif":
        inspect_sif(path, report)
    elif effective == ".sam":
        report["kind"] = "sam"
        report["container"] = "text"
        report["warnings"].append("Validate header/reference and all eleven mandatory alignment fields.")
    else:
        prefix = read_prefix(path)
        if has_hdf5_signature(prefix):
            report["container"] = "hdf5"
            report["warnings"].append("HDF5 container detected, but the application schema is unknown.")
        else:
            report["warnings"].append("No supported format identity was established.")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    reports = [inspect(path) for path in args.paths]
    if args.as_json:
        json.dump(reports, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        for report in reports:
            status = "ok" if report["ok"] else "fail"
            print(f"{status}\t{report['kind']}\t{report['path']}")
            for warning in report["warnings"]:
                print(f"  warning: {warning}")
    return 0 if all(report["ok"] for report in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())

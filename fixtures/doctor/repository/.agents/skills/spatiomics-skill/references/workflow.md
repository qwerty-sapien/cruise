# Provenance-preserving spatial workflow

## Contents

- [Define the contract](#define-the-contract)
- [Inventory and stage](#inventory-and-stage)
- [Plan transformations](#plan-transformations)
- [Run a tiny canary](#run-a-tiny-canary)
- [Execute](#execute)
- [Verify and publish](#verify-and-publish)
- [Minimum manifest](#minimum-manifest)

## Define the contract

Write down the biological question, samples, expected assay/chemistry, organism/assembly, source/target formats, required outputs, protected raw data, coordinate semantics, allowed effects, compute bounds, and acceptance checks. Resolve whether the operation is inspection, conversion, alignment/counting, integration, domain detection, clustering, annotation, or orchestration.

Separate structural correctness from biological validity. A parseable matrix can still have the wrong assembly, sample IDs, orientation, scale, or counts.

## Inventory and stage

1. Hash and inspect every source without mutation.
2. Use `.agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py` for bounded type triage.
3. Create an explicit sample/input manifest; never rely on recursive FASTQ discovery in a mixed directory.
4. Copy or bind sources read-only into an isolated working area.
5. Reserve a distinct output and temporary directory with sufficient space.
6. Capture executable/package/container identities before running anything.

For SIF execution, verify signature or pinned SHA-256 and use a clean environment, containment, minimal read-only source binds, and one writable output bind.

## Plan transformations

For every edge in the dataflow, name:

- exact input and output artifacts;
- reader/writer and pinned version;
- schema/flavor/bin/cell mode;
- coordinate and identifier mapping;
- normalization/aggregation/filtering rules;
- count, dtype, sparse/dense, and metadata preservation expectations;
- semantic checks and rollback/cleanup.

Keep source, normalized, integrated, graph, cluster, and annotation layers distinct. Never overwrite raw counts or source coordinates.

## Run a tiny canary

Before real data, exercise the exact command/environment against a tiny synthetic, redistributable fixture. Require semantic assertions: known dimensions, IDs, counts, coordinates, output types, and deterministic fields. A zero exit code alone is insufficient.

The bundled Doctor fixture provides a small GEM-like matrix, digest-bound manifest, Zarr/GEFF marker, deliberately invalid SIF marker, and non-executable format catalog for offline inspection. `workflow/Snakefile` orchestrates the deterministic validator and inspector without installing or invoking domain packages. These markers do not validate a real biological analysis or replace vendor test data.

## Execute

- Pass arguments without shell interpolation where possible.
- Quote paths, pin locales/seeds, and bound threads, memory, disk, and time.
- Preserve stdout/stderr, tool logs, summaries, and environment/version reports.
- Write atomically to a new output when the tool permits; quarantine partial output on failure.
- Stop on unexpected recursive inputs, schema drift, reference mismatch, coordinate ambiguity, or unapproved external access.

For Snakemake, validate configuration, lint, dry-run, inspect the DAG, run the canary, then run the bounded real target. Keep retries classified and bounded.

## Verify and publish

1. Inspect output container/schema with the target's pinned reader.
2. Compare shapes, samples, IDs/order, count totals, dtypes, sparse/dense layout, coordinates/transforms, layers/results, and required tags/metadata.
3. Run format-specific checks: BAM decode/index, GTF/reference compatibility, HDF5/Zarr schema, or SIF identity.
4. Run representative biological sanity checks declared before execution, without converting them into post hoc success criteria.
5. Compute output hashes and finalize the manifest only after checks pass.
6. Record warnings, exclusions, failures, effects, cleanup, limitations, and exact reproduction commands.

Publish data only to an approved destination. A local workflow contract does not grant network, credential, or external-storage authority.

## Minimum manifest

Record at least:

```json
{
  "schema_version": 1,
  "dataset_id": "stable-local-id",
  "sample_id": "stable-sample-id",
  "organism": "scientific name",
  "assembly": "accession-and-release",
  "assay": "platform-and-chemistry",
  "coordinate_system": {
    "axes": ["x", "y"],
    "unit": "declared-unit",
    "origin": "declared-origin",
    "orientation": "declared-orientation",
    "transform": "identity-or-versioned-transform"
  },
  "inputs": [
    {
      "path": "relative/or-approved-absolute-path",
      "role": "counts-or-coordinates-or-reference",
      "format": "explicit-format-and-flavor",
      "sha256": "64-hex-digest",
      "producer": "tool version"
    }
  ],
  "operation": {
    "tool": "name",
    "version": "exact-version",
    "environment_digest": "sha256-or-lock-identity",
    "argv": ["exact", "argument", "vector"]
  },
  "outputs": [],
  "checks": [],
  "warnings": []
}
```

Extend rather than repurpose fields. Store credentials nowhere in the manifest.

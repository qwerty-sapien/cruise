---
name: spatiomics-skill
description: "Inspect, validate, convert, analyze, and orchestrate spatial transcriptomics data with provenance-preserving workflows for StereoPy/Stereo-seq, SAW 8.1.3, STAR, BANKSY, Leiden, and Snakemake. Use for BAM, GEM, STOmics GEF, GEFF, H5MS, H5AD, annotation tables, reference bundles, GTF/GFF, SIF images, spatial coordinates, expression matrices, domain detection, clustering, format conversion, or reproducible spatial-omics pipelines."
---

# Spatiomics

Treat spatial expression, coordinates, images, annotations, and reference metadata as one versioned dataset. Inspect before loading, preserve source artifacts, write every conversion to a new path, and prove semantic equivalence rather than trusting a successful process exit.

## Start with a bounded inventory

1. Record every input path, size, SHA-256, producing tool/version, organism, assembly, sample, and expected role.
2. From the repository root, run `python3 .agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py --json <paths...>` for bounded, read-only type checks. Treat its result as triage, not biological validation.
3. Resolve ambiguous `.anno` and `.ref` inputs from an explicit manifest. Never infer their schema from the extension.
4. Distinguish STOmics GEF (HDF5 expression data) from GEFF (Zarr graph exchange). Never send GEFF to a GEF reader.
5. Record the coordinate axes, units, origin, orientation, offsets, scale factors, binning mode, and transforms before joining or converting data.

Read [formats.md](references/formats.md) whenever file identity, schema, conversion, or integrity is in scope.

## Select an explicit tool path

- For Stereo-seq matrices, multi-sample data, or AnnData interchange, use the pinned StereoPy methods in [tools.md](references/tools.md). State fixed-bin versus cell-bin mode and H5AD flavor explicitly.
- For raw Stereo-seq processing, pin SAW to `8.1.3`, isolate the intended FASTQ tree, validate the reference, and use the SAW/STAR procedure in [tools.md](references/tools.md).
- For standalone alignment, build and use a version/input-bound STAR index. Do not assume it is interchangeable with SAW's embedded STAR path.
- For spatial domains, choose BANKSY R or Python explicitly, retain unmodified counts, build neighbors within samples, and record all graph/clustering parameters.
- For clustering, record the exact graph, weights, objective, resolution, iteration count, seed, and Leiden implementation. Cluster IDs are not annotations.
- For orchestration, pin Snakemake and every environment/container digest. Declare inputs, outputs, logs, threads, resources, and semantic validation for each rule.

Read [tools.md](references/tools.md) before generating commands or code for these tools. Read [workflow.md](references/workflow.md) for end-to-end planning, provenance, conversion, and verification gates.

## Preserve biological and spatial semantics

- Keep raw integer counts in an identified source or layer; do not overwrite them with normalized values.
- Join expression, coordinates, annotations, and images by validated identifiers, never by row position.
- Preserve gene IDs and gene names separately. Record any version stripping or alias mapping.
- Verify dimensions, identifier sets and order, sparse/dense representation, dtypes, count sums, coordinate ranges, layers/raw slots, and transforms before and after conversion.
- Prevent spatial-neighbor edges from crossing samples unless integration is an explicit, justified operation.
- Use backed/chunked reads for large HDF5 inputs. Write mutations to a new artifact; StereoPy `update_gef` is in-place and therefore requires an owned copy.
- Never treat a preview bin, tissue-filtered matrix, cell-bin matrix, and raw bin1 matrix as interchangeable.

## Execute safely

1. Pin exact tool and library versions; capture `--version` output and environment/container digest.
2. Validate manifests, headers, magic bytes, reference compatibility, free space, and output ownership before work.
3. Dry-run the plan on the tiny synthetic fixture when the command surface supports it.
4. Use explicit argv, quoted paths, bounded threads/memory/time, read-only source mounts, and a distinct writable output directory.
5. Stop on schema, assembly, contig, coordinate, sample-ID, or count-conservation mismatch. Do not coerce silently.
6. Keep intermediate logs and tool summaries needed to reproduce or disconfirm the result.

Use `data/format-markers.json` only to test format routing and fail-closed behavior. Its BAM/HDF5/SIF entries are non-data markers, not parseable biological containers. Use `workflow/Snakefile` as the offline orchestration canary; it invokes only the repository validator and bounded inspector.

Do not download references, install packages, authenticate, access a network, execute an unverified SIF, or modify a source dataset without the host and user permissions required for that effect.

## Verify the result

Require all applicable gates:

- container and format identity are correct;
- input and output manifests are complete and digest-bound;
- FASTA/GTF assembly and contig namespaces match;
- BAM header, EOF, decode, sorting, tags, and index checks pass at the chosen assurance level;
- matrix dimensions, IDs, counts, and coordinates reconcile;
- H5AD/H5MS/GEF round-trip through the pinned implementation without losing required fields;
- BANKSY/Leiden outputs retain parameter, seed, graph, and stability evidence;
- Snakemake lint, config validation, dry-run, tiny-fixture run, and material-output checks pass;
- no unapproved source mutation, cross-sample graph edge, or external effect occurred.

Report exact commands, versions, inputs/outputs, hashes, transformations, checks, warnings, failures, and residual uncertainty. Never claim that structural validation proves biological correctness.

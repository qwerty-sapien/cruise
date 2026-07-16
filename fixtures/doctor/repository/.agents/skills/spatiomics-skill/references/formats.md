# Spatial data formats

## Contents

- [Identity rules](#identity-rules)
- [BAM and SAM](#bam-and-sam)
- [GEM](#gem)
- [STOmics GEF](#stomics-gef)
- [GEFF](#geff)
- [H5AD](#h5ad)
- [H5MS](#h5ms)
- [GTF and GFF](#gtf-and-gff)
- [Annotation tables](#annotation-tables)
- [Reference bundles](#reference-bundles)
- [SIF images](#sif-images)
- [Conversion acceptance](#conversion-acceptance)

## Identity rules

Dispatch from inspected container/schema evidence, not an extension alone. Capture a SHA-256 before reading and after any approved copy. Keep a manifest entry for the producer, producer version, format/schema version, organism, assembly, sample, coordinate system, and intended role.

Never conflate:

- STOmics `GEF` with graph-exchange `GEFF`;
- an SAW 8.1.3 tarball with an Apptainer/Singularity `SIF`;
- the STAR RNA aligner with STARmap;
- generic AnnData with StereoPy-native H5AD/H5ST conventions;
- a filename ending in `.anno` or `.ref` with a universal schema.

The repository's `data/format-markers.json` records minimum container signatures and semantic gates for every supported route. Entries marked `non_executable` or `structural_only` are test vectors, not valid BAM/HDF5/SIF data. In particular, `tiny_not_a_container.sif` must be rejected; it proves that suffix-only SIF detection fails closed.

## BAM and SAM

Use the [SAM/BAM specification](https://samtools.github.io/hts-specs/SAMv1.pdf), [standard tags](https://samtools.github.io/hts-specs/SAMtags.pdf), and [HTS specifications repository](https://github.com/samtools/hts-specs).

Inspection and validation:

1. Confirm BAM/BGZF identity, parse the header, and reconcile every `@SQ` name/length with the bound reference.
2. Run `samtools quickcheck` for a cheap header/EOF gate, but do not treat it as a full record check. Decode or stream every record when higher assurance is required. See [`samtools quickcheck`](https://www.htslib.org/doc/samtools-quickcheck.html).
3. Check sort order, pairing/flags, CIGAR validity, mapping-quality expectations, read groups, duplicate policy, and indexability.
4. Preserve required tags. SAW output may rely on `Cx`, `Cy`, `UR`, `XF`, `GI`, `GE`, `GS`, and `UB`; do not rename or strip them as if they were generic single-cell tags.
5. When filtering or rewriting, compare record counts by flag class, reference counts, tag presence, and representative alignments before accepting the output.

## GEM

GEM is a text expression matrix used by Stereo-seq/SAW. Use the SAW [expression matrix description](https://www.stomics.tech/service/saw_8_1/docs/gao-ji-she-zhi/expression-matrix-format.html) and [official file-format document](https://cdn-newfile.stomics.tech/Stereo-seq_Analysis_Workflow_File_Format_A4.2.pdf).

- Parse metadata/comment lines and the header dynamically; do not assume a fixed number or spelling of columns.
- Preserve gene ID, gene name when present, `x`/`y`, MID/UMI counts, exon counts, cell IDs, offsets, resolution, and any producer metadata.
- Determine whether coordinates describe DNBs, fixed bins, tissue-filtered bins, or cells before aggregation.
- For compressed GEM, validate decompression and parse in a streaming manner.
- Reject joins that use row position or silently collapse duplicate gene/coordinate keys.

## STOmics GEF

GEF is an HDF5 expression container. Consult SAW [matrix outputs](https://www.stomics.tech/service/saw_8_1/docs/analysis/outputs/matrices.html), the [file-format document](https://cdn-newfile.stomics.tech/Stereo-seq_Analysis_Workflow_File_Format_A4.2.pdf), and official [`gefpy`](https://github.com/STOmics/gefpy).

- Verify the HDF5 signature, then read format attributes and datasets with the pinned SAW/StereoPy/gefpy version.
- Classify raw bin1, visualization bin, tissue GEF, and cell-bin GEF explicitly.
- Record bin type/size, resolution, offsets, coordinate extents, gene identifiers, and exon/count availability.
- A cell-bin GEF to GEM conversion also needs the bin GEF when DNB information must be reconstructed.
- `StereoPy.update_gef` mutates its input. Run it only against an owned copy and compare the resulting digest/schema.

## GEFF

GEFF is a Zarr graph-exchange format for tracking/lineage graphs and is unrelated to STOmics GEF. Use the [current specification](https://liveimagetrackingtools.org/geff/latest/specification/) or the [versioned 1.0 reference](https://liveimagetrackingtools.org/geff/spec-v1.0.0/reference/geff_spec/).

- Require a Zarr store and an explicit GEFF schema version.
- Validate node/edge groups, unique integer node IDs, referenced endpoints, axes, units, dimensionality, and required attributes.
- Preserve unknown compliant attributes unless an explicit target schema excludes them.
- Never pass GEFF to `StereoPy.read_gef`, `gefpy`, or SAW GEF conversion commands.

## H5AD

Use the AnnData [on-disk format specification](https://anndata.readthedocs.io/en/stable/fileformat-prose.html), [API](https://anndata.readthedocs.io/en/stable/api.html), and [backed-mode guidance](https://anndata.readthedocs.io/en/stable/tutorials/notebooks/getting-started.html).

- Verify HDF5 identity and the AnnData encoding attributes before loading deeply.
- Check that `X`, layers, `obs`, `var`, `obsm`, `varm`, `obsp`, and `varp` dimensions align with their axes and IDs.
- Record where raw counts live (`X`, a named layer, or `raw`) and never replace them without a new artifact and explicit provenance.
- Base AnnData does not standardize spatial coordinate semantics. Record the key, axis order, units, origin, orientation, transforms, image identity, and scale factors.
- Use backed/chunked inspection for large files. Copy to a new target for changes.
- When converting through StereoPy, name the requested H5AD flavor and verify the round trip; StereoPy-native serialization is not automatically generic interchange.

## H5MS

H5MS is a StereoPy `MSData` serialization rather than a general interchange standard. Use the pinned StereoPy [I/O API](https://stereopy.readthedocs.io/en/latest/content/031_API_IO.html).

- Record the exact StereoPy version that wrote and reads it.
- Validate sample order and identities, relationships/integration mode, variable mode, raw data, results, coordinate metadata, and serialization options.
- Test a read/write/read round trip with the same pinned version before migrating or sharing it.
- Prefer H5AD or another documented interchange only after proving which H5MS semantics survive conversion.

## GTF and GFF

Use the [GENCODE format definition](https://www.gencodegenes.org/pages/data_format.html) and [Ensembl GFF/GTF guide](https://www.ensembl.org/info/website/upload/gff.html).

- Parse nine tab-separated fields with a format-aware parser; the attribute column is not a naive delimiter-separated map.
- Bind the GTF/GFF to an exact FASTA assembly/release and compare contig names and lengths.
- Preserve gene/transcript version suffixes unless an explicit mapping records the removed values.
- Validate coordinate convention, feature hierarchy, strand, gene/transcript identifiers, and required SAW attributes with `saw checkGTF` when targeting SAW.
- Do not silently add/remove `chr` prefixes or mix primary assembly, alternate loci, and decoys.

## Annotation tables

`.anno` has no universal StereoPy, SAW, or AnnData schema. Require a manifest that states:

- delimiter, encoding, header, and null representation;
- entity type and unique join key;
- label namespace, ontology/version, confidence, and provenance;
- coordinate system/units/transforms when coordinates are present;
- duplicate, missing, conflict, and unmatched-ID policy.

Join by validated IDs. Preserve original labels and store normalized/ontology labels separately.

## Reference bundles

`.ref` is not a universal format. Inspect the file or directory manifest before choosing a reader. Record species, assembly accession, FASTA and GTF releases/digests, contig aliases, builder/tool version, arguments, creation date, and license.

For STAR/SAW references, bind:

- FASTA/GTF byte digests and contig namespace;
- STAR and SAW versions;
- `sjdbOverhang` and all index-generation parameters;
- SAW `makeRef --mode STAR` output manifest and `checkGTF` result.

An index is derived data and must not replace its source FASTA/GTF evidence.

## SIF images

Use Apptainer [signature verification](https://apptainer.org/docs/user/latest/signNverify.html), [`apptainer exec`](https://apptainer.org/docs/user/main/cli/apptainer_exec.html), and [environment/containment guidance](https://apptainer.org/docs/user/latest/docker_and_oci.html).

- Verify a trusted signature or pinned SHA-256 before execution.
- Record image digest, source, architecture, runtime version, command, environment, binds, and GPU requirements.
- Prefer `--cleanenv`, containment, minimal read-only input binds, and one explicit writable output bind.
- Inspect first; do not run an image merely because its extension is `.sif`.

## Conversion acceptance

For every conversion, preserve the source and require a new target plus a manifest. Compare:

1. samples, shapes, identifiers, and identifier order;
2. sparse/dense representation, dtypes, missing values, and integer-count preservation;
3. total and per-sample/per-gene counts within the documented transformation;
4. coordinate ranges, axes, units, offsets, bin/cell mode, and transforms;
5. layers/raw/results, annotations, images, graphs, and provenance metadata;
6. tool/version/arguments, warnings, and output digest;
7. read-back and a representative semantic query using the target's pinned reader.

Stop rather than accept unexplained loss, reordering, count drift, coordinate drift, or schema coercion.

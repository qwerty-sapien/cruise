# Spatial transcriptomics tools

## Contents

- [Version policy](#version-policy)
- [StereoPy](#stereopy)
- [SAW 8.1.3](#saw-813)
- [STAR](#star)
- [BANKSY](#banksy)
- [Leiden](#leiden)
- [Snakemake](#snakemake)

## Version policy

Pin the exact executable/package, dependency lock, documentation version, and environment/container digest. Capture version output in the run manifest. Do not copy flags between versions or between R and Python implementations.

The offline examples below use these documentation profiles, not a promise that independently installed packages are mutually compatible:

| Surface | Reference profile | Compatibility boundary |
| --- | --- | --- |
| StereoPy | `1.6.2` | Use its own lock/environment and the 1.6 API signatures recorded below. |
| SAW | `8.1.3` | Use only the 8.1 command surface and vendor archive checksum. |
| STAR | `2.7.11b` | Rebuild indexes when the executable, FASTA, GTF, or index parameters change. |
| BANKSY R | `Banksy 1.5.0` vignette profile | Record the complete R/Bioconductor `sessionInfo()`; do not mix with Python BANKSY results. |
| BANKSY Python | `pybanksy 1.3.4`, Python 3.8-3.12 | Preserve its resolved dependency lock; the package uses Leiden by default. |
| Snakemake | `9.23.1` documentation profile | Validate the bundled Snakefile under the exact installed release before real data. |

For Leiden, pin the implementation with its graph stack: either the R profile's `leidenAlg 1.1.3` and `igraph 2.0.3`, or one exact Python Scanpy/igraph/leidenalg lock. These are separate profiles. Never infer compatibility from a shared algorithm name.

## StereoPy

Primary sources: [StereoPy repository](https://github.com/STOmics/Stereopy), [v1.6.2 release](https://github.com/STOmics/Stereopy/releases/tag/v1.6.2), [I/O API](https://stereopy.readthedocs.io/en/latest/content/031_API_IO.html), [I/O tutorial](https://stereopy.readthedocs.io/en/v1.6.0/Tutorials/IO.html), and [`stereo_to_anndata`](https://stereopy.readthedocs.io/en/latest/content/stereo.io.stereo_to_anndata.html).

Pin `stereopy==1.6.2` for this reference set. Relevant methods include `read_gem`, `read_gef`, `read_gef_info`, `read_h5ad`, `read_h5ms`, their matching writers, and AnnData conversion helpers.

Safe method:

1. Inspect metadata cheaply (`read_gef_info` where applicable) before loading counts.
2. Supply bin type and bin size explicitly; do not infer fixed-bin versus cell-bin semantics from shape.
3. Preserve gene IDs and names as different fields, raw counts, coordinates, offsets, resolution, and sample identity.
4. Use chunked/backed approaches for large inputs and an owned output path for writes.
5. Name the H5AD flavor and target conventions when converting.
6. Read the output with the pinned target reader and compare the conversion gates in `formats.md`.

StereoPy 1.6.2 includes fixes relevant to large GEFs, exon writing, Loom IDs, and SAW 8 tissue GEFs. Treat `update_gef` as an in-place mutation and run it only on an explicit copy.

Practical, offline I/O skeleton for the 1.6 API:

```python
import stereo as st

data = st.io.read_gem(
    "input.gem.gz",
    bin_type="bins",       # or "cell_bins"
    bin_size=50,            # ignored for cell_bins
    is_sparse=True,
    gene_name_index=False,
)
st.io.write_h5ad(data, output="output.h5st", use_raw=True, use_result=True)
round_trip = st.io.read_h5ad(file_path="output.h5st", flavor="stereopy")
```

For a GEF, call `st.io.read_gef_info("input.gef")` first, then `st.io.read_gef("input.gef", bin_type="bins", bin_size=50)`. A `.h5st` written by `write_h5ad` is StereoPy serialization, not generic AnnData. Use `st.io.stereo_to_anndata` for generic H5AD and validate with `anndata.read_h5ad`; never rename `.h5st` to `.h5ad`.

## SAW 8.1.3

Primary sources: [download/checksum/system requirements](https://www.stomics.tech/service/saw_8_1/docs/download-center.html), [commands](https://www.stomics.tech/service/saw_8_1/docs/analysis/pipelines/saw-can-shu-ming-ling.html), [reference preparation](https://www.stomics.tech/service/saw_8_1/docs/shi-yong-jiao-cheng/preparation-of-reference.html), [FASTQ inputs](https://www.stomics.tech/service/saw_8_1/docs/analysis/inputs/fastqs.html), [BAM output](https://www.stomics.tech/service/saw_8_1/docs/analysis/outputs/bam.html), [matrices](https://www.stomics.tech/service/saw_8_1/docs/analysis/outputs/matrices.html), and [format conversion](https://www.stomics.tech/service/saw_8_1/docs/shi-yong-jiao-cheng/shu-ju-ge-shi-zhuan-huan.html).

Pin SAW exactly to `8.1.3`. The official archive MD5 published for that release is `6cd872cffcf539a8c3a2e5447bc290cd`; also record a locally computed SHA-256. Verify `saw --version` after extraction.

Reference preparation:

1. Pin matching FASTA/GTF assembly releases and digests.
2. Check contig namespace and required attributes.
3. Run `saw checkGTF`.
4. Build with `saw makeRef --mode STAR` and retain the command, logs, manifest, and embedded STAR identity.

Counting:

1. Stage only the intended paired FASTQs in a dedicated read-only input tree: SAW count can ingest every FASTQ below supplied directories.
2. Verify R1 carries CID/MID and R2 carries RNA; do not mix paired and grouped layouts.
3. Bind chip/mask/reference inputs, chemistry, sample name, threads/resources, and output directory explicitly.
4. Validate pipeline logs, BAM/reference/tags, GEF/GEM variants, image/registration outputs, and checksums.

Do not mix SAW 8.2 flags or reference assumptions into an 8.1.3 command. The SAW distribution is a self-contained tarball, not a SIF image.

Run the 8.1.3 command surface with explicit paths and a new output directory:

```sh
saw --version
saw checkGTF --input-gtf reference.gtf --output-gtf checked.gtf
saw makeRef --mode=STAR --fasta=reference.fa --gtf=checked.gtf \
  --genome=reference.saw813 --threads-num=8
saw count --id=sample01 --sn=CHIP_SERIAL --omics=transcriptomics \
  --kit-version=KIT --sequencing-type=SEQUENCING_TYPE \
  --chip-mask=chip.mask --reference=reference.saw813 \
  --fastqs=fastq.sample01 --output=out.saw813 --threads-num=8
```

Resolve `KIT`, `SEQUENCING_TYPE`, chip serial, and mask from the experiment record. Do not run the placeholder command. For bounded conversion, use `saw convert gef2gem --gef=input.gef --bin-size=50 --gem=output.gem` or `saw convert gef2h5ad --gef=input.gef --bin-size=50 --h5ad=output.h5ad`, then apply the format acceptance gates.

## STAR

Primary sources: [STAR repository](https://github.com/alexdobin/STAR), [2.7.11b manual](https://github.com/alexdobin/STAR/blob/2.7.11b/doc/STARmanual.pdf), [2.7.11b release](https://github.com/alexdobin/STAR/releases/tag/2.7.11b), and [STARsolo details](https://github.com/alexdobin/STAR/blob/master/docs/STARsolo.md).

For index generation, record STAR version, FASTA/GTF digests, assembly, contig naming, `sjdbOverhang`, genome directory, and every argument. STAR indices are version/input-specific.

For alignment, record input pairing/compression/read command, multimap policy, splice parameters, output sort mode, tags, and resources. Validate `Log.final.out`, BAM header/reference dictionary, representative mappings, sorting, full decoding at the chosen assurance level, and indexability.

Do not substitute an independently built STAR index for SAW's embedded reference unless the exact SAW documentation and validation prove compatibility.

Standalone STAR skeleton:

```sh
STAR --runMode genomeGenerate --runThreadN 8 --genomeDir star-index \
  --genomeFastaFiles reference.fa --sjdbGTFfile reference.gtf --sjdbOverhang 99
STAR --runThreadN 8 --genomeDir star-index --readFilesIn sample_R1.fastq.gz sample_R2.fastq.gz \
  --readFilesCommand zcat --outFileNamePrefix out/sample01. \
  --outSAMtype BAM SortedByCoordinate
```

Replace `sjdbOverhang` with the declared read-length-minus-one policy. Record every omitted/default argument from `Log.out` and `genomeParameters.txt`; do not treat this skeleton as an assay-specific alignment policy.

## BANKSY

Primary sources: [R documentation](https://prabhakarlab.github.io/Banksy/), [domain-segmentation vignette](https://prabhakarlab.github.io/Banksy/articles/domain-segment.html), [Bioconductor package](https://bioconductor.org/packages/release/bioc/html/Banksy.html), [Python repository](https://github.com/prabhakarlab/Banksy_py), [Python v1.3.4](https://github.com/prabhakarlab/Banksy_py/releases/tag/v1.3.4), and the [primary paper](https://www.nature.com/articles/s41588-024-01664-3).

Choose `Banksy` for R/Bioconductor or `Banksy_py` for Python explicitly. Do not translate function names or result fields by guesswork.

Before fitting:

- retain raw counts and document normalization/feature selection;
- prove expression/coordinate ID equality and order;
- split neighbor construction by sample unless cross-sample integration is intended;
- inspect coordinate units/ranges and disconnected observations.

Record `lambda`, `k_geom`, spatial decay, selected genes, scaling, PCA dimensions, graph construction, Leiden implementation/objective/resolution/seed, and all package versions. Compare with a non-spatial `lambda=0` baseline. Treat published/default lambda values as starting points, not universal optima.

Validate stability across justified parameter/seed replicates, spatial coherence without trivial sample partitioning, marker/count integrity, and output-to-input ID mapping.

R profile skeleton after constructing a `SpatialExperiment` named `se` whose columns exactly match the coordinate rows:

```r
se <- Banksy::computeBanksy(se, assay_name = "counts", k_geom = 30)
set.seed(1000)
se <- Banksy::runBanksyPCA(se, lambda = 0.8, npcs = 50)
set.seed(1000)
se <- Banksy::clusterBanksy(se, lambda = 0.8, npcs = 50, resolution = 0.8)
sessionInfo()
```

Python 1.3.4 profile skeleton:

```python
from banksy.initialize_banksy import initialize_banksy
from banksy.run_banksy import run_banksy_multiparam

banksy_dict = initialize_banksy(
    adata, coord_keys=("x", "y", "spatial"),
    num_neighbours=15, nbr_weight_decay="scaled_gaussian",
)
results = run_banksy_multiparam(
    adata, banksy_dict, lambda_list=[0.2], resolutions=[0.5, 1.0],
)
```

The example values are starting points only. Run `lambda=0`, seed replicates, and justified parameter alternatives; retain the result-to-observation mapping.

## Leiden

Primary sources: [Leiden paper](https://www.nature.com/articles/s41598-019-41695-z), [`leidenalg`](https://github.com/vtraag/leidenalg), [documentation](https://leidenalg.readthedocs.io/en/stable/), and [Scanpy API](https://scanpy.readthedocs.io/en/stable/api/scanpy.tl.leiden.html).

Pin Scanpy, igraph, leidenalg, and the chosen implementation path. Record the exact adjacency/neighbor graph identity, whether weights/directionality are used, partition objective, resolution, iterations, random seed, and restricted key/output column.

Check disconnected components, isolates, empty/tiny clusters, stability across seeds/resolutions, and agreement with protected metadata. Preserve numeric membership separately from biological annotation; never label clusters by ID alone.

Given a precomputed, versioned Scanpy neighbor graph:

```python
import scanpy as sc

sc.tl.leiden(
    adata,
    neighbors_key="spatial_neighbors",
    key_added="leiden_r1_seed1000",
    resolution=1.0,
    random_state=1000,
)
```

Persist the exact `adata.obsp` connectivity key, Scanpy/igraph/leidenalg versions, direction/weight policy, and all explicit/default arguments. Never rerun neighbors implicitly inside a clustering step.

## Snakemake

Primary sources: [rules](https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html), [deployment/containers](https://snakemake.readthedocs.io/en/stable/snakefiles/deployment.html), [CLI](https://snakemake.readthedocs.io/en/stable/executing/cli.html), [provenance](https://snakemake.readthedocs.io/en/latest/executing/provenance.html), and [repository/releases](https://github.com/snakemake/snakemake).

Pin Snakemake and use matching documentation. Each rule must declare explicit `input`, `output`, `log`, `threads`, `resources`, environment/container identity, and semantic validation. Quote interpolated filesystem paths with `:q` in shell commands.

Required workflow gates:

1. validate configuration and sample manifests against schemas;
2. run formatter/lint checks and a dry-run/DAG review;
3. run a tiny synthetic fixture without network access;
4. use `ensure(non_empty=True)` and/or checksums for material outputs;
5. use bounded retries only for classified transient failures;
6. emit version/provenance reports and preserve per-rule logs;
7. rerun the dry-run to prove the workflow is complete and stable.

Never mark a source or project root as `directory()` output: Snakemake may remove declared directory outputs before rerunning them.

Offline fixture method:

```sh
snakemake --snakefile workflow/Snakefile --cores 1 --dry-run --printshellcmds
snakemake --snakefile workflow/Snakefile --cores 1 --printshellcmds
snakemake --snakefile workflow/Snakefile --cores 1 --dry-run
```

The second dry-run must report nothing left to produce. The bundled workflow invokes no domain package and no network; it validates orchestration, quoting, logs, and deterministic fixture checks only.

# Spatiomics Skill Fixture

This disposable repository is Cruise Doctor's public end-to-end fixture. It implements a discoverable repository-local `.agents/skills/spatiomics-skill` with progressive references and offline method skeletons for StereoPy, SAW 8.1.3, STAR, BANKSY, Leiden, Snakemake, and common spatial data formats.

The included GEM-like matrix, annotation table, FASTA, GTF, Zarr/GEFF marker, deliberately invalid SIF marker, and format catalog are tiny synthetic offline canaries. The manifest binds every input by SHA-256. Non-data BAM/GEF/H5AD/H5MS/SIF markers test routing requirements only; they are not parseable biological containers or benchmark data.

Run the local validation with:

```sh
node --test tests/spatiomics-fixture.test.mjs
python3 .agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py --json \
  data/tiny_expression.gem data/tiny_reference.gtf data/tiny_labels.anno \
  data/tiny_reference_marker data/tiny_graph.geff
snakemake --snakefile workflow/Snakefile --cores 1 --dry-run --printshellcmds
```

Cruise Doctor copies this directory before every public-skill scenario. Runs write only inside the disposable copy; the source fixture remains unchanged.

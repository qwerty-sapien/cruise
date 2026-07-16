import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_GEM_COLUMNS = Object.freeze(['geneID', 'x', 'y', 'MIDCounts', 'ExonCount']);
const REQUIRED_TOOLS = Object.freeze(['StereoPy', 'SAW 8.1.3', 'STAR', 'BANKSY', 'Leiden', 'Snakemake']);
const REQUIRED_FORMATS = Object.freeze(['BAM', 'GEM', 'GEF', 'GEFF', 'H5AD', 'H5MS', 'ANNO', 'REF', 'GTF', 'SIF']);
const REQUIRED_METHOD_MARKERS = Object.freeze([
  'st.io.read_gem(',
  'saw makeRef',
  'STAR --runMode genomeGenerate',
  'Banksy::computeBanksy',
  'initialize_banksy(',
  'sc.tl.leiden(',
  'snakemake --snakefile workflow/Snakefile',
]);
const REQUIRED_INPUTS = Object.freeze([
  'data/tiny_expression.gem',
  'data/tiny_labels.anno',
  'data/tiny_reference.fa',
  'data/tiny_reference.gtf',
  'data/tiny_reference.ref.json',
  'data/format-markers.json',
  'data/tiny_graph.geff/zarr.json',
  'data/tiny_not_a_container.sif',
  'data/tiny_reference_marker',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveFixtureInput(root, path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('manifest input path must be nonempty');
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`manifest input escapes the fixture: ${path}`);
  }
  return candidate;
}

function assertExactMembers(actual, expected, label) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} must be exactly ${sortedExpected.join(', ')}; found ${sortedActual.join(', ')}`);
  }
}

function parseTsv(contents, { comments = false } = {}) {
  const lines = String(contents).split(/\r?\n/u).filter((line) => line && (!comments || !line.startsWith('#')));
  if (lines.length === 0) throw new Error('table has no header');
  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split('\t');
    if (values.length !== columns.length) throw new Error(`row ${index + 2} has the wrong column count`);
    return Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]]));
  });
  return { columns, rows };
}

async function validateFixtureManifest(root, data) {
  const manifest = JSON.parse(await readFile(resolve(data, 'spatiomics-manifest.json'), 'utf8'));
  const reference = JSON.parse(await readFile(resolve(data, 'tiny_reference.ref.json'), 'utf8'));
  const markerCatalog = JSON.parse(await readFile(resolve(data, 'format-markers.json'), 'utf8'));
  if (manifest.fixture_only !== true || reference.fixture_only !== true) {
    throw new Error('fixture/reference manifests must not imply biological data');
  }
  if (markerCatalog.fixture_only !== true) throw new Error('format markers must be fixture-only');
  if (!Array.isArray(manifest.warnings) || !manifest.warnings.some((warning) => /not biological evidence/iu.test(warning))) {
    throw new Error('fixture manifest must retain its scientific-use warning');
  }

  if (!Array.isArray(manifest.inputs)) throw new Error('fixture manifest inputs must be an array');
  assertExactMembers(manifest.inputs.map(({ path }) => path), REQUIRED_INPUTS, 'manifest inputs');
  const inputDigests = new Map();
  for (const input of manifest.inputs) {
    if (!/^[a-f0-9]{64}$/u.test(input.sha256 ?? '')) {
      throw new Error(`manifest input lacks a SHA-256 digest: ${input.path}`);
    }
    if (inputDigests.has(input.path)) throw new Error(`duplicate manifest input: ${input.path}`);
    const bytes = await readFile(resolveFixtureInput(root, input.path));
    const actual = sha256(bytes);
    if (actual !== input.sha256) {
      throw new Error(`manifest digest mismatch for ${input.path}: expected ${input.sha256}, found ${actual}`);
    }
    inputDigests.set(input.path, actual);
  }

  if (!Array.isArray(reference.files) || reference.files.length !== 2) {
    throw new Error('reference manifest must bind FASTA and GTF digests');
  }
  for (const input of reference.files) {
    const bytes = await readFile(resolveFixtureInput(data, input.path));
    if (sha256(bytes) !== input.sha256) throw new Error(`reference digest mismatch for ${input.path}`);
  }

  if (!Array.isArray(markerCatalog.markers)) throw new Error('format marker catalog is malformed');
  assertExactMembers(markerCatalog.markers.map(({ format }) => format), REQUIRED_FORMATS, 'format markers');
  const byFormat = new Map(markerCatalog.markers.map((marker) => [marker.format, marker]));
  if (byFormat.get('BAM')?.decompressed_magic_hex !== '42414d01') {
    throw new Error('BAM marker must bind decompressed BAM magic');
  }
  for (const format of ['GEF', 'H5AD', 'H5MS']) {
    if (byFormat.get(format)?.container_magic_hex !== '894844460d0a1a0a') {
      throw new Error(`${format} marker must bind the HDF5 signature`);
    }
  }
  if (byFormat.get('SIF')?.expected_inspector_ok !== false) {
    throw new Error('SIF marker must be an explicit negative canary');
  }
  const geffMetadata = JSON.parse(await readFile(resolve(data, 'tiny_graph.geff', 'zarr.json'), 'utf8'));
  if (geffMetadata.zarr_format !== 3 || geffMetadata.attributes?.fixture_only !== true) {
    throw new Error('GEFF marker must be fixture-only Zarr v3 group metadata');
  }
  return { inputDigests, markerCatalog };
}

export async function validateSpatiomicsFixture(root = resolve('.')) {
  const data = resolve(root, 'data');
  const { inputDigests, markerCatalog } = await validateFixtureManifest(root, data);
  const gemBytes = await readFile(resolve(data, 'tiny_expression.gem'));
  const gem = parseTsv(gemBytes.toString('utf8'), { comments: true });
  if (JSON.stringify(gem.columns) !== JSON.stringify(REQUIRED_GEM_COLUMNS)) {
    throw new Error(`unexpected GEM columns: ${gem.columns.join(', ')}`);
  }
  for (const row of gem.rows) {
    for (const field of ['x', 'y', 'MIDCounts', 'ExonCount']) {
      if (!/^\d+$/u.test(row[field])) throw new Error(`${field} must be a nonnegative integer`);
    }
  }

  const annotations = parseTsv(await readFile(resolve(data, 'tiny_labels.anno'), 'utf8'));
  if (JSON.stringify(annotations.columns) !== JSON.stringify(['gene_id', 'label', 'confidence', 'provenance'])) {
    throw new Error(`unexpected annotation columns: ${annotations.columns.join(', ')}`);
  }
  const annotationIds = new Set(annotations.rows.map(({ gene_id: id }) => id));
  if (annotationIds.size !== annotations.rows.length) throw new Error('annotation gene_id values must be unique');
  for (const row of annotations.rows) {
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`annotation confidence must be between zero and one: ${row.gene_id}`);
    }
  }
  const gemIds = new Set(gem.rows.map(({ geneID }) => geneID));
  assertExactMembers(annotationIds, gemIds, 'annotation join keys');

  const fastaLines = (await readFile(resolve(data, 'tiny_reference.fa'), 'utf8')).trim().split(/\r?\n/u);
  if (fastaLines[0] !== '>chrSynthetic') throw new Error('synthetic FASTA must declare chrSynthetic');
  const referenceSequence = fastaLines.slice(1).join('');
  if (!/^[ACGTN]+$/u.test(referenceSequence)) throw new Error('synthetic FASTA contains invalid bases');

  const gtf = (await readFile(resolve(data, 'tiny_reference.gtf'), 'utf8'))
    .trim().split(/\r?\n/u).map((line) => line.split('\t'));
  for (const fields of gtf) {
    const start = Number(fields[3]);
    const end = Number(fields[4]);
    if (
      fields.length !== 9
      || fields[0] !== 'chrSynthetic'
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 1
      || end < start
      || end > referenceSequence.length
    ) {
      throw new Error('synthetic GTF must contain bounded nine-column chrSynthetic features');
    }
  }

  const skillRoot = resolve(root, '.agents', 'skills', 'spatiomics-skill');
  const skill = await readFile(resolve(skillRoot, 'SKILL.md'), 'utf8');
  const formats = await readFile(resolve(skillRoot, 'references', 'formats.md'), 'utf8');
  const tools = await readFile(resolve(skillRoot, 'references', 'tools.md'), 'utf8');
  const workflow = await readFile(resolve(skillRoot, 'references', 'workflow.md'), 'utf8');
  const interfaceMetadata = await readFile(resolve(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  if (!/^---\nname: spatiomics-skill\ndescription: .+\n---\n/u.test(skill)) {
    throw new Error('skill must have valid name/description-only frontmatter');
  }
  if (!interfaceMetadata.includes('$spatiomics-skill')) {
    throw new Error('skill interface metadata must reference $spatiomics-skill');
  }
  for (const term of REQUIRED_TOOLS) {
    if (!`${skill}\n${tools}`.includes(term)) throw new Error(`skill documentation is missing ${term}`);
  }
  for (const term of REQUIRED_FORMATS) {
    const pattern = term === 'ANNO' || term === 'REF'
      ? new RegExp(`\\.${term.toLowerCase()}\\b`, 'u')
      : new RegExp(`\\b${term}\\b`, 'u');
    if (!pattern.test(formats)) throw new Error(`format documentation is missing ${term}`);
  }
  for (const marker of REQUIRED_METHOD_MARKERS) {
    if (!tools.includes(marker)) throw new Error(`offline tool methods are missing ${marker}`);
  }
  if (!workflow.includes('workflow/Snakefile') || !workflow.includes('digest-bound manifest')) {
    throw new Error('workflow reference must route to the digest-bound offline canary');
  }

  const snakefile = await readFile(resolve(root, 'workflow', 'Snakefile'), 'utf8');
  for (const marker of ['rule all:', 'rule validate_fixture:', 'rule inspect_fixture:', 'ensure(', '{input:q}']) {
    if (!snakefile.includes(marker)) throw new Error(`Snakefile is missing ${marker}`);
  }
  if (!snakefile.includes('.agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py')) {
    throw new Error('Snakefile must invoke the discoverable repository skill inspector');
  }

  return Object.freeze({
    gem: Object.freeze({
      rows: gem.rows.length,
      genes: new Set(gem.rows.map(({ geneID }) => geneID)).size,
      mid_counts: gem.rows.reduce((total, { MIDCounts }) => total + Number(MIDCounts), 0),
      sha256: sha256(gemBytes),
    }),
    annotations: annotations.rows.length,
    gtf_features: gtf.length,
    reference_bases: referenceSequence.length,
    manifest_inputs: inputDigests.size,
    format_markers: markerCatalog.markers.length,
    workflow: 'workflow/Snakefile',
    skill: 'spatiomics-skill',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify(await validateSpatiomicsFixture())}\n`);
}

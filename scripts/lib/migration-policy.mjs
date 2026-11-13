import { createHash } from 'node:crypto';

export const MIGRATION_ACTION = Object.freeze({
  autoApply: 'auto-apply',
  requireAnalysis: 'require-analysis',
  requireAuthorization: 'request-user-authorization',
  block: 'block',
});

const MUTATING_QUERY_KEYWORD = /\b(?:alter|call|comment|copy|create|delete|do|drop|execute|grant|insert|merge|refresh|reindex|reset|revoke|security|set|truncate|update|vacuum)\b/iu;
const LOCKING_SELECT = /\bfor\s+(?:no\s+key\s+update|key\s+share|share|update)\b|\binto\s+(?:temporary\s+|temp\s+|unlogged\s+)?[a-z_]/iu;
const DYNAMIC_SQL = /\b(?:do|execute|prepare)\b|\bcopy\b[\s\S]*\bprogram\b|\bcreate\s+(?:or\s+replace\s+)?function\b/iu;
const HIGH_RISK = /\b(?:drop|rename|truncate|revoke|grant|security\s+definer|row\s+level\s+security|policy|trigger|extension|publication|replica\s+identity|alter\s+column|set\s+not\s+null|drop\s+not\s+null|validate\s+constraint|attach\s+partition|detach\s+partition|auth\.|storage\.|realtime\.)\b/iu;
const ALLOWED_TYPES = /^(?:bigint|bigserial|boolean|bytea|date|double\s+precision|inet|integer|interval|json|jsonb|numeric(?:\(\d{1,3}(?:,\s*\d{1,3})?\))?|real|smallint|smallserial|text|timestamptz|time(?:stamp)?(?:\(\d\))?(?:\s+with(?:out)?\s+time\s+zone)?|uuid|varchar(?:\(\d{1,6}\))?)(?:\[\])?(?:\s+null)?$/iu;

function sqlDigest(sql, targetIdentity = '') {
  return createHash('sha256').update(`${targetIdentity}\0${sql}`).digest('hex');
}

function maskSql(sql) {
  const input = String(sql ?? '');
  let output = '';
  let index = 0;
  let blockDepth = 0;
  while (index < input.length) {
    const pair = input.slice(index, index + 2);
    if (pair === '--') {
      const end = input.indexOf('\n', index + 2);
      output += ' '.repeat((end < 0 ? input.length : end) - index);
      index = end < 0 ? input.length : end;
      continue;
    }
    if (pair === '/*') {
      const start = index;
      blockDepth = 1;
      index += 2;
      while (index < input.length && blockDepth > 0) {
        if (input.slice(index, index + 2) === '/*') {
          blockDepth += 1;
          index += 2;
        } else if (input.slice(index, index + 2) === '*/') {
          blockDepth -= 1;
          index += 2;
        } else index += 1;
      }
      if (blockDepth > 0) throw new Error('unterminated SQL block comment');
      output += ' '.repeat(index - start);
      continue;
    }
    if (input[index] === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < input.length) {
        if (input[index] === "'" && input[index + 1] === "'") index += 2;
        else if (input[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else index += 1;
      }
      if (!closed) throw new Error('unterminated SQL string');
      output += "''".padEnd(index - start, ' ');
      continue;
    }
    if (input[index] === '$') {
      const tag = input.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u)?.[0];
      if (tag) {
        const end = input.indexOf(tag, index + tag.length);
        if (end < 0) throw new Error('unterminated SQL dollar string');
        const length = end + tag.length - index;
        output += `${tag}${' '.repeat(Math.max(0, length - tag.length * 2))}${tag}`;
        index += length;
        continue;
      }
    }
    output += input[index];
    index += 1;
  }
  return output;
}

function statementsIn(sql) {
  const masked = maskSql(sql);
  if (/^\s*\\/mu.test(masked)) throw new Error('psql meta-commands are not supported');
  return masked.split(';').map((statement) => statement.trim()).filter(Boolean);
}

function normalizedTable(value) {
  const table = value.toLowerCase();
  return table.includes('.') ? table : `public.${table}`;
}

function parseOperation(statement) {
  const compact = statement.replace(/\s+/gu, ' ').trim();
  const addColumn = compact.match(/^alter table (?:if exists )?(?:only )?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?) add (?:column )?(?:if not exists )?([a-z_][a-z0-9_$]*) (.+)$/iu);
  if (addColumn) {
    const tail = addColumn[3].trim();
    if (ALLOWED_TYPES.test(tail)) {
      return Object.freeze({
        kind: 'add-nullable-column',
        table: normalizedTable(addColumn[1]),
        column: addColumn[2].toLowerCase(),
      });
    }
    return Object.freeze({ kind: 'risky-alter-table', table: normalizedTable(addColumn[1]) });
  }
  const createIndex = compact.match(/^create index concurrently (?:if not exists )?[a-z_][a-z0-9_$]* on (?:only )?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)\b/iu);
  if (createIndex) {
    return Object.freeze({ kind: 'create-index-concurrently', table: normalizedTable(createIndex[1]) });
  }
  const comment = compact.match(/^comment on (?:table|column) ([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)(?:\.[a-z_][a-z0-9_$]*)? is /iu);
  if (comment) return Object.freeze({ kind: 'comment-on', table: normalizedTable(comment[1]) });
  return Object.freeze({
    kind: DYNAMIC_SQL.test(compact)
      ? 'dynamic-sql'
      : HIGH_RISK.test(compact)
        ? 'high-risk-ddl'
        : 'unclassified-sql',
    table: null,
  });
}

function explicitSelectColumns(statement) {
  const match = statement.match(/^select\s+([\s\S]+?)(?:\s+from\s|$)/iu);
  if (!match) return false;
  const list = match[1].replace(/\bcount\s*\(\s*\*\s*\)/giu, 'count(1)');
  return !/(^|,)\s*(?:[a-z_][a-z0-9_$]*\.)?\*\s*(?:,|$)/iu.test(list);
}

export function classifyReadOnlySql(sql) {
  let statements;
  try {
    statements = statementsIn(sql);
  } catch (error) {
    return Object.freeze({ safe: false, reason: 'unparseable-sql', detail: error.message });
  }
  if (statements.length !== 1) return Object.freeze({ safe: false, reason: 'read-only-query-must-be-single-statement' });
  const [statement] = statements;
  if (!/^select\b/iu.test(statement)) return Object.freeze({ safe: false, reason: 'not-a-select' });
  if (MUTATING_QUERY_KEYWORD.test(statement) || LOCKING_SELECT.test(statement)) {
    return Object.freeze({ safe: false, reason: 'select-has-side-effect-risk' });
  }
  if (!explicitSelectColumns(statement)) return Object.freeze({ safe: false, reason: 'select-must-name-minimum-columns' });
  return Object.freeze({ safe: true, reason: 'single-explicit-column-select', statement });
}

function domainForTable(config, table) {
  return config.migration.domains.find((domain) => domain.tables.includes(table)) ?? null;
}

function dependencyProofPassed(evidence) {
  return evidence?.catalogChecked === true
    && Array.isArray(evidence.materialDependencies)
    && evidence.materialDependencies.length === 0
    && evidence.apiExposureChanged === false
    && evidence.policyChanged === false
    && evidence.triggerChanged === false
    && evidence.typeGenerationChanged === false
    && Array.isArray(evidence.applicationReferences)
    && evidence.applicationReferences.length === 0;
}

function policyProofPassed(config, evidence) {
  if (config.profile !== 'business-critical' || config.migration.policyChecks.length === 0) return true;
  return evidence?.checked === true
    && evidence.conflicts === false
    && Array.isArray(evidence.passed)
    && config.migration.policyChecks.every((check) => evidence.passed.includes(check.name));
}

function decision(action, reason, sql, target, details = {}) {
  return Object.freeze({
    action,
    reason,
    digest: sqlDigest(String(sql ?? ''), target.actualIdentity ?? target.expectedProjectRef ?? target.name),
    target: target.name,
    environment: target.environment,
    ...details,
  });
}

function riskFactors(operations, { domains = [] } = {}) {
  const factors = [];
  if (operations.some(({ kind }) => kind === 'dynamic-sql')) factors.push('dynamic SQL cannot be bounded statically');
  if (operations.some(({ kind }) => kind === 'high-risk-ddl')) factors.push('DDL may remove data, alter access, or break a feature');
  if (operations.some(({ kind }) => kind === 'risky-alter-table')) factors.push('column constraints or rewrites may lock, backfill, or reject existing rows');
  if (operations.some(({ kind }) => kind === 'unclassified-sql')) factors.push('SQL effect is uncertain');
  if (domains.length > 1) factors.push('migration crosses configured database domains');
  return Object.freeze(factors);
}

function dependencyRiskFactors(evidence) {
  const factors = [
    ...(evidence.materialDependencies ?? []),
    ...(evidence.applicationReferences ?? []),
    ...(evidence.apiExposureChanged ? ['whole-row API response shape may change'] : []),
    ...(evidence.triggerChanged ? ['whole-row trigger behavior may change'] : []),
    ...(evidence.analysisUnavailable ? ['dependency analysis was unavailable'] : []),
  ];
  return Object.freeze(factors.length > 0 ? factors : ['dependency proof was incomplete']);
}

export function classifyMigration({
  sql,
  target,
  config,
  mode = 'migration',
  targetVerified = false,
  dependencyEvidence = null,
  policyEvidence = null,
  readOnlyEnforced = false,
}) {
  if (!targetVerified) return decision(MIGRATION_ACTION.block, 'target-identity-unverified', sql, target);
  if (target.environment === 'sandbox') {
    return decision(MIGRATION_ACTION.autoApply, 'verified-sandbox-auto-apply', sql, target);
  }
  if (target.environment !== 'production') {
    return decision(MIGRATION_ACTION.block, 'unsupported-target-environment', sql, target);
  }
  if (mode === 'query') {
    const readOnly = classifyReadOnlySql(sql);
    if (!readOnly.safe) return decision(MIGRATION_ACTION.block, readOnly.reason, sql, target, { detail: readOnly.detail ?? null });
    if (!readOnlyEnforced) return decision(MIGRATION_ACTION.block, 'server-read-only-enforcement-required', sql, target);
    return decision(MIGRATION_ACTION.autoApply, 'production-read-only-query', sql, target, {
      statement: String(sql).replace(/;\s*$/u, '').trim(),
    });
  }

  let statements;
  try {
    statements = statementsIn(sql);
  } catch (error) {
    return decision(MIGRATION_ACTION.requireAuthorization, 'uncertain-sql', sql, target, { detail: error.message });
  }
  if (statements.length === 0) return decision(MIGRATION_ACTION.block, 'empty-migration', sql, target);
  const operations = statements.map(parseOperation);
  const tables = [...new Set(operations.map(({ table }) => table).filter(Boolean))];
  if (operations.some(({ kind }) => ['dynamic-sql', 'high-risk-ddl', 'risky-alter-table', 'unclassified-sql'].includes(kind))) {
    return decision(MIGRATION_ACTION.requireAuthorization, 'risky-or-unclassified-production-migration', sql, target, {
      operations,
      affectedTables: tables,
      riskFactors: riskFactors(operations),
    });
  }
  const domains = [...new Set(tables.map((table) => domainForTable(config, table)?.name).filter(Boolean))];
  if (policyEvidence?.checked === true && policyEvidence.conflicts === true) {
    return decision(MIGRATION_ACTION.requireAuthorization, 'configured-data-policy-conflict', sql, target, {
      operations,
      affectedTables: tables,
      domains,
      riskFactors: Object.freeze(['configured data-management policy check failed or found a conflict']),
    });
  }
  const mapped = tables.length > 0 && tables.every((table) => domainForTable(config, table));
  if (domains.length > 1 || (!mapped && tables.length > 1)) {
    return decision(MIGRATION_ACTION.requireAuthorization, 'migration-spans-unproven-database-classes', sql, target, {
      operations,
      affectedTables: tables,
      domains,
      riskFactors: riskFactors(operations, { domains: domains.length > 1 ? domains : ['unmapped-1', 'unmapped-2'] }),
    });
  }
  if (mapped && domains.length === 1) {
    const domain = config.migration.domains.find(({ name }) => name === domains[0]);
    const allowed = !domain.serviceCritical && operations.every(({ kind }) => domain.autoApply.includes(kind));
    if (allowed) {
      if (!policyProofPassed(config, policyEvidence)) {
        return decision(MIGRATION_ACTION.requireAnalysis, 'policy-checks-required', sql, target, {
          operations, affectedTables: tables, domains,
        });
      }
      return decision(MIGRATION_ACTION.autoApply, 'allowlisted-noncritical-domain', sql, target, {
        operations, affectedTables: tables, domains,
      });
    }
  }
  const strictlyAdditive = operations.every(({ kind }) => kind === 'add-nullable-column');
  if (strictlyAdditive) {
    if (dependencyEvidence === null) {
      return decision(MIGRATION_ACTION.requireAnalysis, 'strict-dependency-proof-required', sql, target, {
        operations, affectedTables: tables, domains,
      });
    }
    if (!dependencyProofPassed(dependencyEvidence)) {
      return decision(MIGRATION_ACTION.requireAuthorization, 'dependency-analysis-found-risk-or-uncertainty', sql, target, {
        operations,
        affectedTables: tables,
        domains,
        riskFactors: dependencyRiskFactors(dependencyEvidence),
      });
    }
    if (!policyProofPassed(config, policyEvidence)) {
      return decision(MIGRATION_ACTION.requireAnalysis, 'policy-checks-required', sql, target, {
        operations, affectedTables: tables, domains,
      });
    }
    return decision(MIGRATION_ACTION.autoApply, 'proven-additive-no-material-effects', sql, target, {
      operations, affectedTables: tables, domains,
    });
  }
  return decision(MIGRATION_ACTION.requireAuthorization, 'production-migration-not-proven-minor', sql, target, {
    operations, affectedTables: tables, domains,
  });
}

export function authorizationMatches(decision, authorization) {
  return decision.action === MIGRATION_ACTION.requireAuthorization
    && authorization?.digest === decision.digest
    && authorization?.target === decision.target
    && authorization?.environment === 'production';
}

export function informedMigrationChoices(decision) {
  if (decision.action !== MIGRATION_ACTION.requireAuthorization) return [];
  return Object.freeze([
    Object.freeze({ value: 'authorize-production', label: 'Authorize exact production migration' }),
    Object.freeze({ value: 'sandbox-auto', label: 'Test in sandbox and auto-promote after checks' }),
    Object.freeze({ value: 'sandbox-manual', label: 'Test in sandbox and wait for localhost confirmation' }),
    Object.freeze({ value: 'cancel', label: 'Cancel migration' }),
  ]);
}

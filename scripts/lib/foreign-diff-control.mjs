export const FOREIGN_DIFF_CONTROL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const FOREIGN_DIFF_CONTROL_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const FOREIGN_DIFF_CONTROL_NAME = /^drift-[a-z0-9][a-z0-9-]*\.(?:bin|ya?ml)$/u;

export function isForeignDiffControlName(value) {
  return typeof value === 'string'
    && value.length <= 15
    && FOREIGN_DIFF_CONTROL_NAME.test(value);
}

export const FOREIGN_DIFF_CONTROL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const FOREIGN_DIFF_CONTROL_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const FOREIGN_DIFF_CONTROL_NAME = /^foreign-diff-[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u;

export function isForeignDiffControlName(value) {
  return typeof value === 'string' && FOREIGN_DIFF_CONTROL_NAME.test(value);
}

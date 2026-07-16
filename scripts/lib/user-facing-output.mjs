import { DEFAULT_COMMUNICATION_STYLE } from './communication-style.mjs';

const INTERNAL_BLOCK = /<(?:system|developer|internal|user)(?:\s[^>]*)?>[\s\S]*?(?:<\/(?:system|developer|internal|user)>|$)/giu;
const PROMPT_DISCLOSURE = /(?:^|\n)\s*(?:system|developer|internal|user)\s+(?:prompt|instructions?|message)\s*:[\s\S]*$/giu;
const CONTROL_CHARACTERS = /\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

const REPLACEMENTS = Object.freeze([
  [/\bforeign[- ]diff(?:[- ]inventory)?\b/giu, 'unexpected file changes'],
  [/\btrust boundary\b/giu, 'safety check'],
  [/\bapprove foundation\b/giu, 'approve the plan'],
  [/\bcruise origin\b/giu, 'saved request'],
  [/\b(?:origin|alignment|decisions|goal)\.ya?ml\b/giu, 'saved plan details'],
  [/\b(?:alignment|decisions|spec|plan|goal|roadmap)\.md\b/giu, 'saved plan details'],
  [/\b(?:sha-?256|digest)(?:\s*[:=]\s*[a-f0-9]{8,})?\b/giu, 'review record'],
  [/\bmilestone[- ]controller\b/giu, 'project handoff'],
  [/\bapp[- ]server\b/giu, 'Codex'],
  [/\bcruise (?:client|contract|run)\b/giu, 'Cruise'],
  [/\bdeveloper instructions?\b/giu, 'working guidance'],
  [/\b(?:runtime|workflow) (?:begin|controller|authority|policy)\b/giu, 'work settings'],
]);

function normalize(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\r\n?/gu, '\n');
}

/** Escape untrusted text before placing it inside a structured prompt envelope. */
export function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/**
 * Separates Cruise's fixed instructions from the exact user request. The
 * app-server receives the same request text after XML decoding, but the
 * delimiter prevents user-controlled markup from taking an instruction role.
 */
export function xmlPrompt({ system, user }) {
  // CDATA keeps the original request bytes available to workflows that record
  // the request verbatim. Splitting a CDATA terminator keeps user text from
  // closing the envelope early.
  const userText = String(user ?? '').replace(/\]\]>/gu, ']]]]><![CDATA[>');
  return `<system>\n${escapeXmlText(system).trim()}\n</system>\n<user><![CDATA[\n${userText}\n]]></user>`;
}

/**
 * Mechanical presentation boundary for all text that originated outside the
 * terminal adapter. This deliberately does not rely on a model instruction to
 * keep private workflow text out of the user's view.
 */
export function sanitizeUserFacingText(value, {
  style = DEFAULT_COMMUNICATION_STYLE,
} = {}) {
  let text = normalize(value)
    .replace(INTERNAL_BLOCK, '')
    .replace(PROMPT_DISCLOSURE, '');
  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  // In the default mode, strip boilerplate that is meaningful only to the
  // orchestration layer. Technical and friendly modes retain normal prose,
  // but all three retain the same private-term protection above.
  if (style === DEFAULT_COMMUNICATION_STYLE) {
    text = text.replace(/\b(?:native|persisted|canonical|mechanically)\b/giu, '');
  }
  return text
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function userFacingError(value, options = {}) {
  const safe = sanitizeUserFacingText(value, options);
  return safe || 'Codex could not complete that step.';
}

/** Buffer complete messages so redaction cannot be bypassed across deltas. */
export class UserFacingMessageBuffer {
  constructor({ output, style = DEFAULT_COMMUNICATION_STYLE } = {}) {
    this.output = output;
    this.style = style;
    this.value = '';
  }

  append(delta) {
    this.value += String(delta ?? '');
  }

  flush() {
    const safe = sanitizeUserFacingText(this.value, { style: this.style });
    this.value = '';
    if (safe) this.output?.write(`${safe}\n`);
    return safe;
  }

  clear() {
    this.value = '';
  }
}

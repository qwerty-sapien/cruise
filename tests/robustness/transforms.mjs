// Structure-preserving, reproducible transformations. This searches a bounded
// synthetic input space; it does not optimize a language model or use gradients.
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function mutateScenario(scenario, { split, index, ordinal, seed, rng }) {
  return { ...scenario, id: `${split}-${index}-${ordinal}-${scenario.adapter}`, split, seed,
    token: `${split}-${Math.floor(rng() * 0xffffffff).toString(16)}`,
    // Same error evidence is direct during discovery, nested during held-out.
    statusField: split === 'heldout' ? 'cause' : 'httpStatusCode',
    // Approval noise is an invalid answer before an explicit answer or EOF.
    noiseBefore: rng() > 0.5,
    // Framing changes retain the same JSON-RPC semantic frame.
    splitFrames: rng() > 0.5,
  };
}

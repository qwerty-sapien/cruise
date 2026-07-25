# Web assurance profile

Select `web` for browser-facing interfaces. Define gates for:

- `accessibility`: semantic structure, keyboard use, focus behavior, labels, contrast, and reduced-motion behavior are appropriate.
- `responsive-ui`: the intended journeys remain usable at representative narrow and wide viewports without clipping or accidental overflow.
- `browser-runtime`: critical journeys, loading/empty/error states, navigation, and console/runtime behavior work in a real browser.

Prefer browser-driven evidence over screenshots alone. A visually attractive initial state does not establish interaction behavior, async recovery, or accessibility. Add security or performance gates when the feature handles untrusted content, authentication, large assets, or latency-sensitive journeys.

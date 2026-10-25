/**
 * Prompt-section placement for the tool instructions.
 *
 * dsh 0.2.x moved the tool band from 100–199 to 1000–3100 and started
 * allocating those slots centrally, reachable through
 * `systemPrompt.getSectionOrder()`. Ask the host when it can answer, so this
 * section keeps rendering next to the other content tools; hosts without that
 * method (0.1.x) keep the historical 160.
 *
 * @module dsh-bilibili/prompt
 */

/** Position this plugin used before dsh 0.2.x rebanded the tool sections. */
const LEGACY_SECTION_ORDER = 160;

/** Host-side slot we sit next to: the web-fetch tool instructions. */
const REFERENCE_SECTION = "TOOL_WEB_FETCH";

/** Offset from the reference slot, keeping us inside the tool band. */
const ORDER_OFFSET = 50;

/**
 * Resolve this plugin's system-prompt position against the running host.
 *
 * @param systemPrompt - the injected `systemPrompt` service (may be an older shape).
 * @returns the allocated order when the host answers; the legacy slot otherwise.
 */
function resolveSectionOrder(systemPrompt) {
  try {
    const base = systemPrompt?.getSectionOrder?.(REFERENCE_SECTION);
    if (typeof base === "number" && Number.isFinite(base)) return base + ORDER_OFFSET;
  } catch {
    // Host answers for a different allocation set; fall back to the legacy slot.
  }
  return LEGACY_SECTION_ORDER;
}

export { LEGACY_SECTION_ORDER, REFERENCE_SECTION, ORDER_OFFSET, resolveSectionOrder };

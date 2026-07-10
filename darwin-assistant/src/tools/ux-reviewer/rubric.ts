// JARVIS UX Reviewer — the rubric ("where the taste lives") (DAR-685).
//
// This is what makes the reviewer *Kevin's* reviewer and not a generic linter.
// Slice 2 (vision critique) feeds this to a vision-capable model alongside each
// captured screenshot. Objective = broken/ugly, non-negotiable. Subjective =
// human-touch: does it feel good, what would make it easier to see/use.
//
// Project-agnostic DEFAULTS live here; per-project configs may append overrides.

export interface Rubric {
  objective: string[]; // checklist — each is a defect if violated
  subjective: string[]; // open prompts — each invites a suggestion, not a pass/fail
}

// Kevin's named defects are first-class here (markdown rendering, timestamps).
export const DEFAULT_RUBRIC: Rubric = {
  objective: [
    'Markdown MUST render: bold/italic/lists/newlines/code must show as formatting, never as raw ** _ ` or literal \\n. Raw markdown in rendered output is a first-class defect.',
    'No text overflow or clipping: content is not cut off at container/viewport edges; long strings wrap or truncate with an affordance (ellipsis / scroll), never silently disappear.',
    'Responsive: at each viewport (mobile/tablet/desktop) nothing important is off-screen with no way to reach it; tables/rows either reflow or offer horizontal scroll.',
    'Contrast is legible: text vs background meets a readable ratio; no low-contrast gray-on-gray or color-on-color that is hard to read.',
    'Alignment & spacing: columns, labels, and controls line up on a consistent grid; no jagged edges, overlapping elements, or uneven padding.',
    'Timestamps are correct and human-readable: relative times ("2h ago") are plausible, never negative, never a raw ISO string or epoch where a friendly time belongs.',
    'States are handled: loading shows an indicator, empty shows an empty-state (not a blank void), error shows an error message (not a silent failure or infinite spinner).',
    'Interactive affordances are visible: buttons/links look clickable; disabled vs enabled is distinguishable; focus/active states exist.',
    'No obvious broken assets: no missing images/icons (broken-image glyphs), no unstyled flash-of-content, no console errors that surface visually.',
  ],
  subjective: [
    'Does this feel good to use — is the primary action obvious within a second of looking?',
    'What one visual or feature would make this screen easier to see or use?',
    'Is anything visually noisy or cluttered that could be simplified or given breathing room?',
    'Does the hierarchy guide the eye to what matters first, or does everything compete?',
    'For this specific screen/state, is there information a human would expect to see that is missing?',
  ],
};

/** Render the rubric as a prompt block for the vision model. */
export function rubricToPrompt(r: Rubric = DEFAULT_RUBRIC): string {
  const obj = r.objective.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const sub = r.subjective.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return [
    'You are a meticulous senior product designer reviewing a real screenshot of a running app.',
    'Judge ONLY what is visible in the image. Cite the specific region for each finding.',
    '',
    'OBJECTIVE — report each violation as a defect (severity: high/medium/low):',
    obj,
    '',
    'SUBJECTIVE — human-touch improvements (report as suggestions, not defects):',
    sub,
  ].join('\n');
}

export function getComposerEditorMinHeight(fontSize: number) {
  // ~2.5 lines — a touch taller than a strict two-line box.
  return Math.ceil(fontSize * 1.4 * 2.5 + 6)
}

export function getCompactComposerEditorMinHeight(fontSize: number) {
  return Math.ceil(fontSize * 1.4 + 6)
}

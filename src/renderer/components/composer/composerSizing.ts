export function getComposerEditorMinHeight(fontSize: number) {
  // ~2.4 lines at idle.
  return Math.ceil(fontSize * 1.4 * 2.4 + 6)
}

export function getCompactComposerEditorMinHeight(fontSize: number) {
  return Math.ceil(fontSize * 1.4 + 6)
}

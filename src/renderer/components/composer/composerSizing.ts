export function getComposerEditorMinHeight(fontSize: number) {
  // ~3 lines at idle — a bit roomier than a two-line box.
  return Math.ceil(fontSize * 1.4 * 3 + 6)
}

export function getCompactComposerEditorMinHeight(fontSize: number) {
  return Math.ceil(fontSize * 1.4 + 6)
}

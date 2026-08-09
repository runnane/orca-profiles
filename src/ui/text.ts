/**
 * Explanations in this app name the config key that decided something, and put it
 * in `backticks` — because the same string has to work in three places: as markup
 * in a view, as an `aria-label`, and as terminal output in `src/cli/report.ts`. So
 * the ticks live in the string, `CodeText` turns them into `<code>`, and this
 * strips them for anywhere markup cannot go. A screen reader should not read
 * punctuation that only means "monospace".
 */
export function plainText(text: string): string {
  return text.replace(/`/g, '');
}

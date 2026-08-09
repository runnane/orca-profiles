/**
 * Prose with `backticked` config keys in it, rendered as markup.
 *
 * Explanations in this app name the key that decided something, and a key is worth
 * setting in monospace — but the strings themselves have to stay plain text,
 * because the same sentence is used as an `aria-label` and as terminal output in
 * `src/cli/report.ts`. So the backticks live in the string and are turned into
 * `<code>` here; `plainText` in `./text` strips them for anywhere markup cannot
 * go.
 */

export function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        // Odd segments are what was between a pair of backticks.
        i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

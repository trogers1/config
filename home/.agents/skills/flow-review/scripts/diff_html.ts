import { diffArrays, diffWordsWithSpace } from 'diff';
import { changeStatuses, type Example } from './schema.js';

type Highlight = ({ code }: { code: string }) => string;
type Range = { start: number; end: number };
const rowKinds = { added: changeStatuses.added, removed: changeStatuses.removed, context: 'context' } as const;
type RowKind = typeof rowKinds[keyof typeof rowKinds];
const entities = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

function requireAt<T>({ items, index }: { items: readonly T[]; index: number }): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing paired diff item at index ${index}`);
  return item;
}

function decodeEntity({ entity }: { entity: string }): string {
  const name = entity.slice(1, -1);
  const named = entities.get(name);
  if (named !== undefined) return named;
  if (/^#(?:x[\da-f]+|\d+)$/iu.test(name)) {
    const hex = name.startsWith('#x') || name.startsWith('#X');
    const value = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) return String.fromCodePoint(value);
  }
  throw new Error(`Unsupported entity in highlighted diff: ${entity}`);
}

function lines({ code }: { code: string | undefined }): string[] {
  // Excerpts are not whole files: a missing final newline is not a meaningful change.
  return code === undefined ? [] : code.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
}

function wordRanges({ before, after }: { before: string; after: string }) {
  const removed: Range[] = [];
  const added: Range[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  for (const part of diffWordsWithSpace(before, after)) {
    if (part.removed) removed.push({ start: oldOffset, end: oldOffset + part.value.length });
    if (part.added) added.push({ start: newOffset, end: newOffset + part.value.length });
    if (!part.added) oldOffset += part.value.length;
    if (!part.removed) newOffset += part.value.length;
  }
  return { removed, added };
}

function highlightedContent({ code, ranges, highlight }: { code: string; ranges: readonly Range[]; highlight: Highlight }): string {
  let offset = 0;
  let decoded = '';
  // Only trusted highlighter markup is parsed. Input code must already be escaped.
  // Reopen emphasis within each text node to avoid crossing syntax-token spans.
  const result = highlight({ code }).split(/(<[^>]*>)/gu).map((token) => {
    if (token.startsWith('<')) return token;
    let output = '';
    let emphasized = false;
    for (const atom of token.match(/&[^;\s]*;|[^&]/gu) ?? []) {
      const text = atom.startsWith('&') ? decodeEntity({ entity: atom }) : atom;
      const changed = ranges.some((range) => offset < range.end && offset + text.length > range.start);
      if (changed !== emphasized) output += changed ? '<span class="diff-word">' : '</span>';
      emphasized = changed;
      output += atom;
      decoded += text;
      offset += text.length;
    }
    return output + (emphasized ? '</span>' : '');
  }).join('');
  if (decoded !== code) throw new Error('Highlighted diff text does not match the source line');
  return result;
}

export function renderDiff({ example, highlight }: { example: Example; highlight: Highlight }): string {
  if (example.before === undefined && example.after === undefined) throw new Error(`Example ${example.id} has no before/after code to compare`);
  const changes = diffArrays(lines({ code: example.before }), lines({ code: example.after }));
  const rows: string[] = [];
  let oldNumber = 1;
  let newNumber = 1;
  function row({ line, kind, ranges = [] }: { line: string; kind: RowKind; ranges?: readonly Range[] }): void {
    const old = kind === rowKinds.added ? '' : oldNumber++;
    const next = kind === rowKinds.removed ? '' : newNumber++;
    const sign = kind === rowKinds.added ? '+' : kind === rowKinds.removed ? '−' : ' ';
    const content = highlightedContent({ code: line, ranges, highlight });
    rows.push(`<span class="diff-line diff-${kind}"><span class="diff-number" aria-hidden="true">${old}</span><span class="diff-number" aria-hidden="true">${next}</span><span class="diff-sign" aria-label="${kind}">${sign}</span><span class="diff-content">${content || ' '}</span></span>`);
  }
  let consumedReplacement = false;
  for (const [index, change] of changes.entries()) {
    if (consumedReplacement) {
      consumedReplacement = false;
    } else {
      const next = changes[index + 1];
      if (change.removed && next?.added && change.value.length === next.value.length) {
        const pairs = change.value.map((before, position) => wordRanges({ before, after: requireAt({ items: next.value, index: position }) }));
        change.value.forEach((line, position) => row({ line, kind: rowKinds.removed, ranges: requireAt({ items: pairs, index: position }).removed }));
        next.value.forEach((line, position) => row({ line, kind: rowKinds.added, ranges: requireAt({ items: pairs, index: position }).added }));
        consumedReplacement = true;
      } else {
        const kind: RowKind = change.added ? rowKinds.added : change.removed ? rowKinds.removed : rowKinds.context;
        for (const line of change.value) row({ line, kind });
      }
    }
  }
  const title = example.before === undefined ? 'Addition' : example.after === undefined ? 'Deletion' : 'Before → after';
  return `<section><h4>${title}</h4><p class="diff-key">− Deleted · + Added · Stronger shading marks changed words. Line numbers: before / after.</p><pre class="diff" tabindex="0" role="region" aria-label="Code diff"><code class="hljs">${rows.join('')}</code></pre></section>`;
}

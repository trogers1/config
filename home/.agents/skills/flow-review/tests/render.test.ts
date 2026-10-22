import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseReview, type Review } from '../scripts/schema.js';

const skill = resolve(import.meta.dirname, '../..');
const renderer = join(skill, 'dist/scripts/render_flow_html.js');
const fixture = parseReview({ unverifiedData: JSON.parse(readFileSync(join(skill, 'examples/float-comparisons.flow.json'), 'utf8')) });

function run({ args }: { args: string[] }) {
  return spawnSync(process.execPath, [renderer, ...args], { encoding: 'utf8' });
}

function workspace({ t }: { t: TestContext }) {
  const directory = mkdtempSync(join(tmpdir(), 'flow-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { input: join(directory, 'flow.json'), output: join(directory, 'flow.html') };
}

function writeInput({ input, document }: { input: string; document: unknown }) {
  writeFileSync(input, JSON.stringify(document));
}

test('public CLI validates and renders the review, colored flows, syntax and code differences offline', (t) => {
  const { input, output } = workspace({ t });
  writeInput({ input, document: fixture });
  const validation = run({ args: ['--validate', input] });
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(existsSync(output), false);
  const result = run({ args: [input] });
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(output, 'utf8');
  for (const text of [fixture.title, fixture.summary, fixture.context, ...fixture.themes.map((theme) => theme.title)]) {
    assert.ok(html.includes(text), `Missing narrative: ${text}`);
  }
  for (const theme of fixture.themes) {
    for (const example of theme.examples) assert.ok(html.includes(`id="item-${example.id}"`));
  }
  assert.match(html, /<svg\b/);
  assert.match(html, /class="flow-connection added"/);
  assert.match(html, /class="diff-line diff-removed"/);
  assert.match(html, /class="diff-line diff-added"/);
  assert.match(html, /class="diff-word"/);
  assert.match(html, /class="hljs-keyword"/);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//);
});

test('invalid inputs fail without overwriting an existing review', (t) => {
  const { input, output } = workspace({ t });
  const existing = 'existing review';
  writeFileSync(output, existing);
  for (const document of [{ ...fixture, unknown: true }, { ...fixture, coverage: [] }, { ...fixture, summary: 42 }]) {
    writeInput({ input, document });
    const result = run({ args: [input, output] });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.trim());
    assert.equal(readFileSync(output, 'utf8'), existing);
  }
});

test('source text is escaped even with syntax and diff highlighting', (t) => {
  const { input, output } = workspace({ t });
  const payload = '<script>alert(1)</script>';
  const document = {
    ...fixture,
    summary: payload,
    themes: fixture.themes.map((theme) => ({
      ...theme,
      examples: theme.examples.map((example) => ({ ...example, before: payload, after: `${payload}\nreturn 1` })),
    })),
  } satisfies Review;
  writeInput({ input, document });
  const result = run({ args: [input, output] });
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(output, 'utf8');
  assert.ok(!html.includes(payload));
  assert.ok(html.includes('&lt;script&gt;'));
});

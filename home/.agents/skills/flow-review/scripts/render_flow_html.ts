#!/usr/bin/env node
/** Offline renderer. schema.ts is the shape and reference authority. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import highlighter from 'highlight.js';
import { renderDiff } from './diff_html.js';
import { changeStatuses, verificationStatuses, parseReview, type Review, type Example, type Diagram } from './schema.js';

const usage = `Usage: node dist/scripts/render_flow_html.js <input.json> [output.html]
       node dist/scripts/render_flow_html.js --validate <input.json>
       node dist/scripts/render_flow_html.js --help

Validate structured review JSON and render standalone, offline HTML.
Default output: input path with .json replaced by .html.
All prose is plain text (no Markdown/HTML). Sources are safe plain labels.
The authoritative contract is scripts/schema.ts. No network is used.`;

function escapeHtml({ value }: { value: string }): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const e = escapeHtml;
function prose({ text }: { text: string | undefined }): string { return text === undefined ? '' : `<p class="prose">${e({ value: text })}</p>`; }
function link({ id, title }: { id: string; title: string }): string { return `<a href="#item-${e({ value: id })}">${e({ value: title })}</a>`; }
type ExampleLocations = ReadonlyMap<string, { theme: Review['themes'][number]; number: number }>;
function exampleLocation({ locations, id }: { locations: ExampleLocations; id: string }) {
  const location = locations.get(id);
  if (location === undefined) throw new Error(`Missing theme for example ${id}`);
  return location;
}
function evidenceLink({ id, title, locations }: { id: string; title: string; locations: ExampleLocations }): string {
  const location = exampleLocation({ locations, id });
  return `<a href="#item-${e({ value: id })}" data-evidence aria-label="${e({ value: title })}: code evidence in theme ${location.number}">${e({ value: title })}</a>`;
}
function exampleHtml({ example, theme, themeNumber }: { example: Example; theme: Review['themes'][number]; themeNumber: number }): string {
  const language = example.language?.toLowerCase();
  if (language !== undefined && !highlighter.getLanguage(language)) {
    throw new Error(`Example ${example.id}: unsupported language ${example.language}; use a highlight.js language or omit language for plain text`);
  }
  const highlight = ({ code }: { code: string }): string => language !== undefined ? highlighter.highlight(code, { language, ignoreIllegals: true }).value : e({ value: code });
  const snippets = (example.before !== undefined || example.after !== undefined ? renderDiff({ example, highlight }) : '') +
    (example.code !== undefined ? `<section><h4>Code</h4><pre><code class="hljs">${highlight({ code: example.code })}</code></pre></section>` : '');
  const sources = example.sources.map((source) => `<li><code>${e({ value: source.path })}</code>${source.revision ? ` @ ${e({ value: source.revision })}` : ''}${source.lines ? ` : ${source.lines.start}${source.lines.end !== undefined ? `–${source.lines.end}` : ''}` : ''}</li>`).join('');
  return `<article id="item-${example.id}" class="example"><p class="eyebrow">Theme ${themeNumber} · ${e({ value: theme.title })}</p><h3>${e({ value: example.title })}</h3>${prose({ text: example.explanation })}<details open><summary>Inspect code and sources</summary>${example.pseudocode ? '<p><strong>Pseudocode</strong></p>' : ''}${example.language ? `<p>Language: ${e({ value: example.language })}</p>` : ''}${snippets}<h4>Sources</h4><ul>${sources}</ul></details></article>`;
}

function position({ positions, id }: { positions: ReadonlyMap<string, number>; id: string }): number {
  const value = positions.get(id);
  if (value === undefined) throw new Error(`Missing diagram position for node ${id}`);
  return value;
}
const statusStyles = {
  [changeStatuses.added]: { label: '＋ Added', color: '#1a7f37', fill: '#dafbe1', darkColor: '#7ee787', darkFill: '#142d20' },
  [changeStatuses.modified]: { label: '↻ Modified', color: '#946200', fill: '#fff2c6', darkColor: '#eac54f', darkFill: '#342b13' },
  [changeStatuses.removed]: { label: '− Removed', color: '#c62838', fill: '#ffebe9', darkColor: '#ffa198', darkFill: '#3d1c20' },
  [changeStatuses.unchanged]: { label: 'Unchanged context', color: '#66758a', fill: 'var(--paper)', darkColor: '#a0aec0', darkFill: 'var(--paper)' },
} satisfies Record<Diagram['nodes'][number]['status'], { label: string; color: string; fill: string; darkColor: string; darkFill: string }>;
const statusCss = Object.entries(statusStyles).map(([status, style]) => `.${status}{--flow-color:${style.color};--flow-fill:${style.fill}}`).join('');
const darkStatusCss = Object.entries(statusStyles).map(([status, style]) => `.${status}{--flow-color:${style.darkColor};--flow-fill:${style.darkFill}}`).join('');
function diagramHtml({ diagram, locations }: { diagram: Diagram; locations: ExampleLocations }): string {
  // Ordered left-to-right nodes; separate arrow lanes make skips/back-edges explicit.
  const positions = new Map(diagram.nodes.map((node, index) => [node.id, 20 + index * 300]));
  const width = diagram.nodes.length * 300 - 40;
  const height = 210 + diagram.edges.length * 42;
  const edges = diagram.edges.map((edge, index) => {
    const from = position({ positions, id: edge.from }) + 110;
    const to = position({ positions, id: edge.to }) + 110;
    const lane = 180 + index * 42;
    const path = from === to ? `M ${from - 40} 140 V ${lane} H ${to + 40} V 148` : `M ${from} 140 V ${lane} H ${to} V 148`;
    const status = edge.status ?? changeStatuses.unchanged;
    const marker = `arrow-${diagram.id}-${index}`;
    return `<g class="flow-connection ${status}"><title>${status.toUpperCase()} connection${edge.label ? `: ${e({ value: edge.label })}` : ''}</title><defs><marker id="${marker}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="flow-arrow"/></marker></defs><path d="${path}" class="flow-edge" marker-end="url(#${marker})"/><text x="${(from + to) / 2}" y="${lane + 20}" text-anchor="middle" class="edge-label">${e({ value: edge.label ?? '' })} [${status.toUpperCase()}]</text></g>`;
  }).join('');
  const nodes = diagram.nodes.map((node) => {
    const location = node.exampleId === undefined ? undefined : exampleLocation({ locations, id: node.exampleId });
    const label = `<rect x="0" y="0" width="220" height="120" rx="8" class="flow-box ${node.status}"/><foreignObject x="10" y="8" width="200" height="106"><div xmlns="http://www.w3.org/1999/xhtml" class="flow-label"><strong>${e({ value: node.label })}</strong><span class="flow-status">${node.status.toUpperCase()}</span>${location ? `<small>Theme ${location.number} · explore code ↗</small>` : ''}</div></foreignObject>`;
    return `<g id="item-${node.id}" transform="translate(${position({ positions, id: node.id })} 20)">${node.exampleId ? `<a href="#item-${node.exampleId}" data-evidence aria-label="${e({ value: node.label })}: explore code evidence">${label}</a>` : label}</g>`;
  }).join('');
  const legend = Object.entries(statusStyles).map(([status, style]) => `<span class="${status}">${style.label}</span>`).join(' ');
  return `<section id="item-${diagram.id}"><h2>${e({ value: diagram.title })}</h2>${prose({ text: diagram.explanation })}<p class="reading-hint">Arrows show execution or data relationships, not the order of the themes. Colored boxes open optional code evidence without changing your reading position.</p><p class="flow-legend">${legend}</p><div class="diagram"><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="group" aria-label="${e({ value: diagram.title })}">${edges}${nodes}</svg></div></section>`;
}

function render({ data }: { data: Review }): string {
  const locations: ExampleLocations = new Map(data.themes.flatMap((theme, index) => theme.examples.map((example) => [example.id, { theme, number: index + 1 }])));
  const themeLinks = data.themes.map((theme, index) => link({ id: theme.id, title: `${index + 1}. ${theme.title}` }));
  const nav = `<a href="#doc-reading-order">Start here</a>${themeLinks.join('')}<a href="#doc-findings">Review results</a><a href="#doc-deep-dives">Optional deep dives</a>`;
  const readingGuide = `<section id="doc-reading-order" class="reading-guide"><h2>How to read this review</h2><p>Read the numbered themes in order for the full story. Each theme explains the change before offering optional code. Diagram links are cross-references, not a guided tour: they may refer to only some themes.</p><ol>${data.themes.map((theme) => `<li>${link({ id: theme.id, title: theme.title })}</li>`).join('')}</ol><p>Explore a diagram box to inspect evidence in a dialog; close it to continue where you left off.</p></section>`;
  const themes = data.themes.map((theme, index) => {
    const previous = data.themes[index - 1];
    const next = data.themes[index + 1];
    const progress = `<div class="theme-progress">${previous ? link({ id: previous.id, title: `← Previous: ${previous.title}` }) : '<a href="#doc-reading-order">← Reading guide</a>'}${next ? link({ id: next.id, title: `Next: ${next.title} →` }) : '<a href="#doc-findings">Continue to review results →</a>'}</div>`;
    return `<section id="item-${theme.id}" class="theme"><p class="eyebrow">Theme ${index + 1} of ${data.themes.length}</p><h2>${index + 1}. ${e({ value: theme.title })}</h2>${prose({ text: theme.explanation })}${theme.examples.map((example) => exampleHtml({ example, theme, themeNumber: index + 1 })).join('')}${progress}</section>`;
  }).join('');
  const coverage = data.coverage.map((entry) => `<li>${entry.paths.map((path) => `<code>${e({ value: path })}</code>`).join(', ')}${prose({ text: entry.explanation })}</li>`).join('');
  const findings = (data.findings ?? []).map((finding) => `<section id="item-${finding.id}"><h3>${e({ value: finding.title })} <span class="badge">${finding.status}</span></h3>${prose({ text: finding.explanation })}<p>${finding.exampleIds.map((id) => evidenceLink({ id, title: `Theme ${exampleLocation({ locations, id }).number}: ${id}`, locations })).join(' · ')}</p></section>`).join('');
  const verification = (data.verification ?? []).map((entry) => `<li><strong>${entry.status}</strong> <code>${e({ value: entry.command })}</code>${prose({ text: entry.explanation })}</li>`).join('');
  const sections = (data.sections ?? []).map((section) => `<section id="item-${section.id}" class="deep-dive"><h3>${e({ value: section.title })}</h3>${prose({ text: section.summary })}<details open><summary>Read full breakdown</summary>${prose({ text: section.explanation })}</details></section>`).join('');
  const fileCount = new Set(data.coverage.flatMap((entry) => entry.paths)).size;
  const verificationSummary = Object.values(verificationStatuses).map((status) => `${(data.verification ?? []).filter((entry) => entry.status === status).length} ${status}`).join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${e({ value: data.title })}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--paper:#fff;--ink:#182337;--line:#c6ced9;--link:#165ab5}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif}.layout{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:2rem;max-width:100rem;margin:auto;padding:2rem}nav{position:sticky;top:1rem;align-self:start;display:grid;gap:.6rem}main{background:var(--paper);padding:clamp(1rem,4vw,4rem);min-width:0}h1,h2,h3,h4{line-height:1.25}h1{font-size:2.5rem}h2{margin-top:2.5rem;border-bottom:1px solid var(--line);padding-bottom:.5rem}a{color:var(--link)}a:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:4px}.prose{white-space:pre-wrap;overflow-wrap:anywhere}details,.diagram{border:1px solid var(--line);border-radius:.4rem;padding:1rem;margin:1rem 0}summary{cursor:pointer;font-size:1.1rem;font-weight:650}pre{overflow:auto;background:var(--bg);padding:1rem;border:1px solid var(--line)}code{font-family:ui-monospace,monospace;overflow-wrap:anywhere}pre code{overflow-wrap:normal}.badge{font-size:.8em;border:1px solid var(--line);padding:.15rem .4rem}section,details,li{scroll-margin-top:1rem}:target{outline:2px solid var(--link);outline-offset:4px}li{margin:.4rem 0}@media(max-width:55rem){.layout{display:block;padding:1rem}nav{position:static;margin-bottom:1rem}}@media(prefers-color-scheme:dark){:root{--bg:#101722;--paper:#192332;--ink:#e5eaf4;--line:#58677c;--link:#91c3ff}}@media print{.layout{display:block;padding:0}nav{display:none}main{padding:0}pre{white-space:pre-wrap}details{break-inside:avoid}}
.diagram{overflow-x:auto}.diagram svg{display:block;color:var(--ink)}${statusCss}.flow-box{fill:var(--flow-fill);stroke:var(--flow-color);stroke-width:2}.flow-box.${changeStatuses.removed},.${changeStatuses.removed} .flow-edge{stroke-dasharray:6 4}.flow-box.${changeStatuses.unchanged}{stroke-dasharray:4 4}.flow-edge{fill:none;stroke:var(--flow-color);stroke-width:2}.flow-arrow{fill:var(--flow-color)}.edge-label{fill:var(--flow-color);font-size:12px}.flow-legend{display:flex;flex-wrap:wrap;gap:.6rem;font-size:.85rem}.flow-legend span{color:var(--flow-color);background:var(--flow-fill);border:1px solid var(--flow-color);padding:.15rem .5rem;border-radius:4px}@media(prefers-color-scheme:dark){${darkStatusCss}}.flow-label{display:flex;flex-direction:column;justify-content:center;gap:3px;height:100%;font-size:14px;line-height:1.25;overflow:auto;overflow-wrap:anywhere;color:var(--ink)}.flow-status{font-size:11px;letter-spacing:.06em}.diagram a:hover .flow-box,.diagram a:focus .flow-box{stroke:var(--link);stroke-width:3}.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#8250df}.hljs-string,.hljs-regexp,.hljs-attribute{color:#0a6370}.hljs-number,.hljs-symbol,.hljs-built_in,.hljs-type{color:#0550ae}.hljs-title{color:#953800}.hljs-comment,.hljs-quote{color:#596579;font-style:italic}.hljs-meta,.hljs-attr{color:#9a3650}@media(prefers-color-scheme:dark){.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#d2a8ff}.hljs-string,.hljs-regexp,.hljs-attribute{color:#a5d6ff}.hljs-number,.hljs-symbol,.hljs-built_in,.hljs-type{color:#79c0ff}.hljs-title{color:#ffa657}.hljs-comment,.hljs-quote{color:#a0aec0}.hljs-meta,.hljs-attr{color:#ff9aaf}}
.diff{padding:0;tab-size:4}.diff>code{display:block;min-width:max-content}.diff-line{display:flex;min-height:1.65em;white-space:pre}.diff-number{display:inline-block;flex:0 0 4ch;text-align:right;padding:0 .5ch;color:#596579;user-select:none;border-right:1px solid var(--line)}.diff-sign{display:inline-block;flex:0 0 3ch;text-align:center;user-select:none}.diff-content{display:block;padding-right:1rem}.diff-context{background:transparent}.diff-added{background:${statusStyles.added.fill}}.diff-removed{background:${statusStyles.removed.fill}}.diff-added .diff-sign{color:${statusStyles.added.color}}.diff-removed .diff-sign{color:${statusStyles.removed.color}}.diff-word{font-weight:700;border-radius:2px}.diff-added .diff-word{background:#a1e8b4;box-shadow:0 0 0 1px #66bc80}.diff-removed .diff-word{background:#ffc1bb;box-shadow:0 0 0 1px #e08c83}@media(prefers-color-scheme:dark){.diff-number{color:#a0aec0}.diff-added{background:${statusStyles.added.darkFill}}.diff-removed{background:${statusStyles.removed.darkFill}}.diff-added .diff-sign{color:${statusStyles.added.darkColor}}.diff-removed .diff-sign{color:${statusStyles.removed.darkColor}}.diff-added .diff-word{background:#245638;box-shadow:0 0 0 1px #3b8052}.diff-removed .diff-word{background:#733038;box-shadow:0 0 0 1px #ab4e55}}
.example,.deep-dive{margin:1.4rem 0;padding:1rem 1.25rem;border-left:3px solid var(--line);background:var(--bg)}.example h3,.deep-dive h3{margin:.3rem 0}.example details,.deep-dive details{background:var(--paper);margin-bottom:0}.eyebrow{font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--link);margin:.5rem 0}.reading-guide{padding:1rem 1.5rem;background:var(--bg);border:1px solid var(--line)}.reading-guide h2{margin-top:.5rem}.reading-hint{font-size:.9rem}.theme-progress{display:flex;justify-content:space-between;flex-wrap:wrap;gap:1rem;margin:1.5rem 0 2rem}.theme-progress a{max-width:45%;font-size:.9rem}dialog{width:min(72rem,94vw);max-height:90vh;overflow:auto;background:var(--paper);color:var(--ink);border:1px solid var(--line);padding:1.5rem;border-radius:.6rem}dialog::backdrop{background:#0008}.dialog-toolbar{display:flex;justify-content:space-between;gap:1rem;align-items:center}.dialog-toolbar button{font:inherit;padding:.4rem .8rem;cursor:pointer}#doc-evidence .example{margin-top:1rem}@media print{dialog{display:none}}
</style></head><body><div class="layout"><nav aria-label="Reading order"><strong>Read in order</strong>${nav}</nav><main><h1>${e({ value: data.title })}</h1>${prose({ text: data.summary })}<p><strong>Baseline:</strong> <code>${e({ value: data.baseline.base })}</code> → <code>${e({ value: data.baseline.head })}</code></p><h2>Context</h2>${prose({ text: data.context })}${readingGuide}${(data.diagrams ?? []).map((diagram) => diagramHtml({ diagram, locations })).join('')}${themes}<section id="doc-findings"><h2>Review results</h2>${findings || '<p>No findings were supplied in this review.</p>'}</section><section id="doc-deep-dives"><h2>Optional deep dives</h2><section class="deep-dive"><h3>Changed-file coverage</h3><p>${fileCount} files in ${data.coverage.length} responsibility groups. This inventory supports completeness; it is not the reading order.</p><details open><summary>Inspect changed-file map</summary><ul>${coverage}</ul></details></section>${verification ? `<section class="deep-dive"><h3>Verification</h3><p>${verificationSummary}. Expand for commands, evidence, and limitations.</p><details open><summary>Inspect verification details</summary><ul>${verification}</ul></details></section>` : ''}${sections}</section></main></div><dialog id="doc-evidence" aria-label="Code evidence"><div class="dialog-toolbar"><strong>Optional code evidence</strong><button type="button" id="doc-close-evidence">Close and return to reading</button></div><div id="doc-evidence-content"></div></dialog>
<script>
// Raw HTML stays expanded for no-JS readers. Enhancement puts the story first.
for(const details of document.querySelectorAll('details'))details.open=false;
function reveal({scroll=true}={}){const target=document.getElementById(location.hash.slice(1));if(!target)return;let node=target;while(node){if(node.tagName==='DETAILS')node.open=true;node=node.parentElement;}if(scroll)target.scrollIntoView();}
addEventListener('hashchange',()=>reveal({}));addEventListener('DOMContentLoaded',()=>reveal({}));
addEventListener('beforeprint',()=>{for(const details of document.querySelectorAll('details')){details.dataset.printOpen=String(details.open);details.open=true;}});
addEventListener('afterprint',()=>{for(const details of document.querySelectorAll('details'))details.open=details.dataset.printOpen==='true';});
const evidenceDialog=document.getElementById('doc-evidence');
const evidenceContent=document.getElementById('doc-evidence-content');
document.getElementById('doc-close-evidence')?.addEventListener('click',()=>{if(evidenceDialog instanceof HTMLDialogElement)evidenceDialog.close();});
document.addEventListener('click',(event)=>{
  if(!(event.target instanceof Element))return;
  const anchor=event.target.closest('a[href^="#"]');
  if(!anchor)return;
  const href=anchor.getAttribute('href');
  if(anchor.hasAttribute('data-evidence')&&evidenceDialog instanceof HTMLDialogElement&&evidenceContent){
    const target=href?document.getElementById(href.slice(1)):null;
    if(!target)throw new Error('Missing linked evidence: '+href);
    event.preventDefault();
    const clone=target.cloneNode(true);
    if(!(clone instanceof HTMLElement))throw new Error('Evidence must be an HTML element');
    clone.removeAttribute('id');
    for(const element of clone.querySelectorAll('[id]'))element.removeAttribute('id');
    for(const details of clone.querySelectorAll('details'))details.open=true;
    evidenceContent.replaceChildren(clone);
    evidenceDialog.showModal();
  }else if(href===location.hash)reveal({});
});
</script></body></html>\n`;
}

async function main({ args }: { args: string[] }): Promise<void> {
  const first = args[0];
  if (args.length === 1 && (first === '--help' || first === '-h')) { console.log(usage); return; }
  const validateOnly = first === '--validate';
  if ((validateOnly && args.length !== 2) || (!validateOnly && (args.length < 1 || args.length > 2)) || args.some((arg, index) => arg.startsWith('-') && !(index === 0 && validateOnly))) throw new Error(usage);
  const input = args[validateOnly ? 1 : 0];
  if (input === undefined) throw new Error(usage);
  if (!input.toLowerCase().endsWith('.json')) throw new Error('Input must have a .json suffix');
  const unverifiedData: unknown = JSON.parse(await readFile(resolve(input), 'utf8'));
  const data = parseReview({ unverifiedData });
  if (validateOnly) { console.log(`Valid: ${input}`); return; }
  const output = args[1] ?? `${input.slice(0, -5)}.html`;
  if (resolve(input) === resolve(output)) throw new Error('Output must not overwrite input JSON');
  if (!output.toLowerCase().endsWith('.html')) throw new Error('Output must have a .html suffix');
  await writeFile(resolve(output), render({ data }), 'utf8');
  console.log(`Rendered ${input} → ${output}`);
}
main({ args: process.argv.slice(2) }).catch((error: unknown) => { console.error(`Error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });

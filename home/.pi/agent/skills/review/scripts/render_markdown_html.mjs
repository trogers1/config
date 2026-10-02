#!/usr/bin/env node
/**
 * Render Markdown as a standalone, browser-viewable HTML review artifact.
 *
 * The generator uses Node's standard library and fetches pinned Marked from
 * jsDelivr at generation time. Markdown is embedded as rendered HTML; only
 * Mermaid diagrams need network access when the generated page is opened.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const usage = `Usage: node scripts/render_markdown_html.mjs <input.md> [output.html]

Render Markdown as styled standalone HTML. The default output is the input path
with its .md suffix replaced by .html.`;

function escapeHtml({ value }) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function outputPathFor({ inputPath, suppliedOutputPath }) {
	if (suppliedOutputPath !== undefined) {
		return suppliedOutputPath;
	}
	if (!inputPath.toLowerCase().endsWith('.md')) {
		throw new Error(`Expected a Markdown input file, received: ${inputPath}`);
	}
	return `${inputPath.slice(0, -3)}.html`;
}

function documentTitle({ inputPath, markdown }) {
	return /^#\s+(.+)$/mu.exec(markdown)?.[1] ?? basename(inputPath, '.md');
}

async function loadMarked() {
	const response = await fetch('https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js', {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Unable to load Markdown renderer: HTTP ${response.status}`);
	}
	const source = await response.text();
	const { marked } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
	return marked;
}

function renderDocument({ markdown, title, marked }) {
	const usedHeadingIds = new Map();
	const contents = [];
	const renderer = new marked.Renderer();
	renderer.heading = (text, level, raw) => {
		const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'section';
		const count = usedHeadingIds.get(base) ?? 0;
		usedHeadingIds.set(base, count + 1);
		const id = count === 0 ? base : `${base}-${count}`;
		if (level <= 3) {
			contents.push(`<a href="#${id}" class="level-${level}">${escapeHtml({ value: raw })}</a>`);
		}
		return `<h${level} id="${id}">${text}</h${level}>\n`;
	};
	const renderedMarkdown = marked.parse(markdown, { gfm: true, renderer });

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml({ value: title })}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f8fa; --paper: #fff; --text: #172033; --muted: #5c667a; --rule: #dfe3ea; --link: #135fc1; --code: #f0f2f6; --accent: #e9f2ff; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .layout { display: grid; grid-template-columns: minmax(13rem, 16rem) minmax(0, 1fr); gap: clamp(1.25rem, 3vw, 3rem); width: 100%; margin: 2.5rem 0; padding: 0 clamp(1.25rem, 3vw, 2.5rem); align-items: start; }
    aside { position: sticky; top: 1.5rem; max-height: calc(100vh - 3rem); overflow-y: auto; padding: .5rem 0; }
    aside h2 { margin: 0 0 .65rem; color: var(--muted); font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; }
    #table-of-contents { display: grid; gap: .2rem; border-left: 2px solid var(--rule); }
    #table-of-contents a { padding: .18rem .55rem; color: var(--muted); font-size: .84rem; line-height: 1.3; text-decoration: none; }
    #table-of-contents a:hover { color: var(--link); background: var(--accent); }
    #table-of-contents .level-2 { padding-left: 1rem; }
    #table-of-contents .level-3 { padding-left: 1.45rem; font-size: .78rem; }
    main { min-width: 0; padding: 2rem clamp(1.25rem, 4vw, 4rem) 4rem; background: var(--paper); box-shadow: 0 2px 20px #17203312; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2.2rem 0 .8rem; scroll-margin-top: 1rem; }
    h1 { margin-top: 0; font-size: clamp(2rem, 5vw, 3rem); letter-spacing: -.03em; }
    h2 { padding-bottom: .35rem; border-bottom: 1px solid var(--rule); font-size: 1.65rem; }
    h3 { font-size: 1.25rem; }
    p { margin: .8rem 0; }
    a { color: var(--link); text-decoration-thickness: .08em; text-underline-offset: .14em; }
    code { padding: .12em .3em; border-radius: .25rem; background: var(--code); font: .9em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-word; }
    pre { overflow: auto; margin: 1.1rem 0; padding: 1rem 1.15rem; border: 1px solid var(--rule); border-radius: .5rem; background: var(--code); font: .84rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre code { padding: 0; background: transparent; }
    .mermaid { overflow: auto; margin: 1.1rem 0; padding: 1rem; border: 1px solid var(--rule); border-radius: .5rem; background: #fff; text-align: center; }
    ul, ol { padding-left: 1.5rem; }
    li { margin: .3rem 0; }
    .table-wrap { overflow-x: auto; margin: 1.1rem 0; border: 1px solid var(--rule); border-radius: .5rem; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { padding: .65rem .8rem; vertical-align: top; text-align: left; border-bottom: 1px solid var(--rule); }
    th { background: var(--accent); font-weight: 650; }
    tr:last-child td { border-bottom: 0; }
    #render-error { display: none; color: #a12020; }
    @media (max-width: 56rem) { .layout { display: block; margin: 0; padding: 0; } aside { position: static; max-height: none; padding: 1.25rem; background: var(--paper); border-bottom: 1px solid var(--rule); } #table-of-contents { grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); } main { box-shadow: none; } }
    @media print { body { background: #fff; } .layout { display: block; max-width: none; margin: 0; padding: 0; } aside { display: none; } main { padding: 0; box-shadow: none; } a { color: inherit; } }
    @media (prefers-color-scheme: dark) { :root { --bg: #10131a; --paper: #191e28; --text: #e7ebf2; --muted: #aeb8c8; --rule: #333b4c; --link: #8cc2ff; --code: #111722; --accent: #182c47; } }
  </style>
</head>
<body>
  <div class="layout">
    <aside aria-label="Table of contents">
      <h2>Contents</h2>
      <nav id="table-of-contents">${contents.join('\n')}</nav>
    </aside>
    <main id="content">${renderedMarkdown}</main>
  </div>
  <p id="render-error">Unable to render one or more diagrams. The document remains readable; diagram source is shown instead. Connect to the internet and reload to retry.</p>
  <script type="module">
    const error = document.querySelector('#render-error');
    const diagrams = document.querySelectorAll('#content code.language-mermaid');
    if (diagrams.length > 0) {
      try {
        const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
        let index = 0;
        for (const code of diagrams) {
          try {
            const { svg } = await mermaid.render('review-diagram-' + index++, code.textContent);
            const diagram = document.createElement('div');
            diagram.className = 'mermaid';
            diagram.innerHTML = svg;
            code.closest('pre').replaceWith(diagram);
          } catch (renderingError) {
            console.error(renderingError);
            error.style.display = 'block';
          }
        }
      } catch (renderingError) {
        console.error(renderingError);
        error.style.display = 'block';
      }
    }
  </script>
</body>
</html>
`;
}

async function main() {
	const arguments_ = process.argv.slice(2);
	if (arguments_.length === 0 || arguments_.includes('-h') || arguments_.includes('--help')) {
		console.log(usage);
		return;
	}
	if (arguments_.length > 2) {
		throw new Error(usage);
	}

	const [inputPath, suppliedOutputPath] = arguments_;
	const outputPath = outputPathFor({ inputPath, suppliedOutputPath });
	const markdown = await readFile(resolve(inputPath), 'utf8');
	const marked = await loadMarked();
	await writeFile(
		resolve(outputPath),
		renderDocument({ markdown, title: documentTitle({ inputPath, markdown }), marked }),
		'utf8',
	);
	console.log(`Rendered ${inputPath} → ${outputPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

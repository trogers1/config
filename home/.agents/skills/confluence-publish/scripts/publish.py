# /// script
# requires-python = ">=3.11"
# dependencies = ["markdown==3.7", "requests==2.32.3"]
# ///
"""Publish Markdown docs to Confluence pages under one parent folder or page.

    uv run ~/.agents/skills/confluence-publish/scripts/publish.py CONFIG [--offline | --dry-run] [--text-only] [--verify]

CONFIG is a JSON file (see SKILL.md):

    {"base": "https://<site>.atlassian.net/wiki", "space": "LM", "parent": "5362974732",
     "docs": ["guide.md", "other-guide.md"]}

Doc paths are relative to CONFIG. Each doc's "# Title" line is its page title. Pages are found by
title in the space and updated, or created under the parent. Images (relative paths) are uploaded
as attachments. "<!-- toc -->" becomes Confluence's table of contents, ">" quotes become info
panels (warning panels when they contain ⚠️), and jump links ("#heading") and links to other docs
in CONFIG ("other.md#heading") become Confluence links.

Credentials: CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN, or else the macOS Keychain item named
"confluence-api-token" (its account is the email).
"""

import argparse
import html
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass

import markdown
import requests

KEYCHAIN_SERVICE = 'confluence-api-token'
FULL_WIDTH = 760
TABLE_WIDTH = 360
TOC_MARKER = '<!-- toc -->'
LIST_ITEM = re.compile(r'^( *)([-*]|\d+\.) ')


class PublishError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    base: str
    space: str
    parent: str
    docs: list  # absolute paths
    toc_min: int
    toc_max: int


@dataclass(frozen=True)
class Page:
    path: str
    title: str
    body: str
    images: dict  # attachment file name -> absolute path
    anchors: frozenset


def load_config(*, path):
    try:
        raw = json.load(open(path))
    except (OSError, json.JSONDecodeError) as error:
        raise PublishError(f'Cannot read config {path}: {error}') from error
    allowed = {'base', 'space', 'parent', 'docs', 'toc'}
    unknown = set(raw) - allowed
    if unknown:
        raise PublishError(f'Unknown config keys: {", ".join(sorted(unknown))}')
    for key in ['base', 'space', 'parent']:
        if not isinstance(raw.get(key), str) or not raw[key].strip():
            raise PublishError(f'Config "{key}" must be a non-empty string')
    if not re.match(r'^https://[^/]+/wiki$', raw['base'].rstrip('/')):
        raise PublishError('Config "base" must look like https://<site>.atlassian.net/wiki')
    if not re.match(r'^\d+$', raw['parent']):
        raise PublishError('Config "parent" must be a numeric folder or page id')
    docs = raw.get('docs')
    if not isinstance(docs, list) or not docs or not all(isinstance(d, str) and d.endswith('.md') for d in docs):
        raise PublishError('Config "docs" must be a non-empty list of .md paths')
    toc = raw.get('toc', {})
    if not isinstance(toc, dict) or set(toc) - {'minLevel', 'maxLevel'}:
        raise PublishError('Config "toc" may only hold minLevel and maxLevel')
    toc_min, toc_max = toc.get('minLevel', 2), toc.get('maxLevel', 3)
    if not (isinstance(toc_min, int) and isinstance(toc_max, int) and 1 <= toc_min <= toc_max <= 6):
        raise PublishError('Config "toc" levels must be integers with 1 <= minLevel <= maxLevel <= 6')
    root = os.path.dirname(os.path.abspath(path))
    paths = [os.path.normpath(os.path.join(root, doc)) for doc in docs]
    for doc in paths:
        if not os.path.isfile(doc):
            raise PublishError(f'Doc not found: {doc}')
    if len(set(paths)) != len(paths):
        raise PublishError('Config "docs" lists a doc twice')
    return Config(base=raw['base'].rstrip('/'), space=raw['space'], parent=raw['parent'], docs=paths,
                  toc_min=toc_min, toc_max=toc_max)


def slug(*, text):
    """GitHub's heading anchor, which Markdown jump links are written against."""
    text = html.unescape(re.sub(r'<[^>]+>', '', text)).strip().lower()
    return re.sub(r'[^\w\- ]', '', text).replace(' ', '-')


def attribute(*, value):
    """Escapes text for a double-quoted XHTML attribute."""
    return html.escape(value, quote=False).replace('"', '&quot;')


def split_title(*, source, path):
    match = re.match(r'# (.+)\n', source)
    if not match:
        raise PublishError(f'{path} must start with a "# Title" line')
    return match.group(1).strip(), source[match.end():]


def python_markdown_lists(*, source):
    """Re-indent CommonMark lists (as Prettier and GitHub write them) for Python-Markdown.

    CommonMark nests a list item's content at its marker's width (2 for "- ", 3 for "1. ") and lets
    a list follow a paragraph directly; Python-Markdown nests only at 4-space steps and needs a
    blank line before a list. Each line's depth comes from the open list items' content columns.
    """
    out, columns, fenced = [], [], False
    for line in source.split('\n'):
        if line.lstrip().startswith('```'):
            fenced = not fenced
            out.append(line)
            continue
        if fenced or not line.strip():
            out.append(line)
            continue
        indent = len(line) - len(line.lstrip(' '))
        while columns and indent < columns[-1]:
            columns.pop()
        item = LIST_ITEM.match(line)
        previous = out[-1] if out else ''
        if item and not columns and previous.strip() and not previous.startswith(' ') \
                and not LIST_ITEM.match(previous):
            out.append('')
        out.append(' ' * (4 * len(columns)) + line.lstrip(' '))
        if item:
            columns.append(indent + len(item.group(2)) + 1)
    return '\n'.join(out)


def to_storage(*, path, titles, toc_min, toc_max):
    """Converts one doc to Confluence storage format. titles maps every published doc path to its title."""
    title, body_md = split_title(source=open(path).read(), path=path)
    rendered = markdown.markdown(python_markdown_lists(source=body_md),
                                 extensions=['tables', 'sane_lists', 'fenced_code'], output_format='xhtml')
    # Confluence shows a newline inside a paragraph as a hard line break. Code blocks keep theirs.
    blocks = re.split(r'(<pre>.*?</pre>)', rendered, flags=re.S)
    rendered = ''.join(b if b.startswith('<pre>') else re.sub(r'\s*\n\s*', ' ', b) for b in blocks)

    markers = rendered.count(TOC_MARKER)
    if markers > 1:
        raise PublishError(f'{path} has more than one {TOC_MARKER} marker')
    rendered = rendered.replace(TOC_MARKER, (
        '<ac:structured-macro ac:name="toc">'
        f'<ac:parameter ac:name="minLevel">{toc_min}</ac:parameter>'
        f'<ac:parameter ac:name="maxLevel">{toc_max}</ac:parameter></ac:structured-macro>'))

    anchors = set()

    def heading(match):
        level, inner = match.group(1), match.group(2)
        anchor = slug(text=inner)
        if anchor in anchors:
            raise PublishError(f'{path} has two headings with the anchor #{anchor}')
        anchors.add(anchor)
        return (f'<h{level}><ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">{anchor}'
                f'</ac:parameter></ac:structured-macro>{inner}</h{level}>')

    rendered = re.sub(r'<h([1-6])>(.*?)</h\1>', heading, rendered, flags=re.S)

    jumps, cross = [], []
    doc_dir = os.path.dirname(path)

    def link(match):
        href, inner = html.unescape(match.group(1)), match.group(2)
        if re.match(r'^[a-z][a-z0-9+.-]*:', href, re.I):
            return match.group(0)  # external (https:, mailto:)
        target = re.match(r'^([^#]*\.md)?(?:#([\w-]+))?$', href)
        if not target or not (target.group(1) or target.group(2)):
            raise PublishError(f'{path}: link "{href}" is neither external, a jump link, nor a published doc')
        page, anchor = target.group(1), target.group(2)
        attrs = f' ac:anchor="{anchor}"' if anchor else ''
        ref = ''
        if page:
            page_path = os.path.normpath(os.path.join(doc_dir, page))
            if page_path not in titles:
                raise PublishError(f'{path}: links to {page}, which is not in the config')
            if page_path != path:
                ref = f'<ri:page ri:content-title="{attribute(value=titles[page_path])}" />'
                cross.append((page_path, anchor))
        if anchor and not ref:
            jumps.append(anchor)
        return f'<ac:link{attrs}>{ref}<ac:link-body>{inner}</ac:link-body></ac:link>'

    rendered = re.sub(r'<a href="([^"]+)">(.*?)</a>', link, rendered, flags=re.S)

    images = {}

    def image(match, *, width):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', match.group(0)))
        src = html.unescape(attrs['src'])
        if re.match(r'^[a-z][a-z0-9+.-]*:', src, re.I):
            raise PublishError(f'{path}: remote image {src}; only local images are supported')
        image_path = os.path.normpath(os.path.join(doc_dir, src))
        if not os.path.isfile(image_path):
            raise PublishError(f'{path}: image not found: {src}')
        name = os.path.basename(image_path)
        if images.get(name, image_path) != image_path:
            raise PublishError(f'{path}: two different images are named {name}; attachments need unique names')
        images[name] = image_path
        alt = attribute(value=html.unescape(attrs.get('alt', '')))
        return (f'<ac:image ac:alt="{alt}" ac:width="{width}">'
                f'<ri:attachment ri:filename="{attribute(value=name)}" /></ac:image>')

    # Images in table cells (side-by-side screenshots) are narrower.
    rendered = re.sub(r'<td>(.*?)</td>', lambda m: '<td>' + re.sub(
        r'<img [^>]*/>', lambda i: image(i, width=TABLE_WIDTH), m.group(1)) + '</td>', rendered, flags=re.S)
    rendered = re.sub(r'<img [^>]*/>', lambda i: image(i, width=FULL_WIDTH), rendered)

    def panel(match):
        inner = match.group(1).strip()
        kind = 'warning' if '⚠️' in inner else 'info'
        inner = inner.replace('⚠️ ', '').replace('⚠️', '')
        return (f'<ac:structured-macro ac:name="{kind}"><ac:rich-text-body>{inner}'
                f'</ac:rich-text-body></ac:structured-macro>')

    rendered = re.sub(r'<blockquote>(.*?)</blockquote>', panel, rendered, flags=re.S)

    for anchor in jumps:
        if anchor not in anchors:
            raise PublishError(f'{path}: jump link #{anchor} has no matching heading')
    try:
        ET.fromstring('<root xmlns:ac="ac" xmlns:ri="ri">' + rendered + '</root>')
    except ET.ParseError as error:
        raise PublishError(f'{path}: converted page is not valid XHTML ({error})') from error
    return Page(path=path, title=title, body=rendered, images=images, anchors=frozenset(anchors)), cross


def convert_all(*, config):
    titles = {}
    for path in config.docs:
        titles[path] = split_title(source=open(path).read(), path=path)[0]
    if len(set(titles.values())) != len(titles):
        raise PublishError('Two docs have the same "# Title"; page titles must be unique')
    pages, cross_links = {}, []
    for path in config.docs:
        page, cross = to_storage(path=path, titles=titles, toc_min=config.toc_min, toc_max=config.toc_max)
        pages[path] = page
        cross_links += [(path, target, anchor) for target, anchor in cross]
    for source, target, anchor in cross_links:
        if anchor and anchor not in pages[target].anchors:
            raise PublishError(f'{source}: links to #{anchor} in {os.path.basename(target)}, which has no such heading')
    return pages


def credentials():
    email = os.environ.get('CONFLUENCE_EMAIL', '').strip()
    token = os.environ.get('CONFLUENCE_API_TOKEN', '').strip()
    if email and token:
        return email, token
    if sys.platform == 'darwin':
        found = subprocess.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-g'],
                               capture_output=True, text=True)
        account = re.search(r'"acct"<blob>="([^"]*)"', found.stdout)
        secret = subprocess.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
                                capture_output=True, text=True)
        if found.returncode == 0 and secret.returncode == 0 and account and secret.stdout.strip():
            return email or account.group(1), secret.stdout.strip()
    raise PublishError(
        'No Confluence credentials. Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN, or store the token in '
        f'the Keychain: security add-generic-password -s {KEYCHAIN_SERVICE} -a you@example.com -w')


class Confluence:
    def __init__(self, *, base, auth):
        self.base = base
        self.session = requests.Session()
        self.session.auth = auth

    def call(self, *, method, path, **kwargs):
        response = self.session.request(method, self.base + path, timeout=60, **kwargs)
        if response.status_code >= 400:
            raise PublishError(f'{method} {path}: HTTP {response.status_code}: {response.text[:600]}')
        return response.json() if response.content else None

    def space_id(self, *, key):
        results = self.call(method='GET', path='/api/v2/spaces', params={'keys': key})['results']
        if len(results) != 1:
            raise PublishError(f'Space {key} not found')
        return results[0]['id']

    def find_page(self, *, space_id, title):
        results = self.call(method='GET', path='/api/v2/pages', params={'space-id': space_id, 'title': title})['results']
        if len(results) > 1:
            raise PublishError(f'Several pages in the space are titled "{title}"')
        return results[0] if results else None

    def create_page(self, *, space_id, parent, title, body):
        return self.call(method='POST', path='/api/v2/pages', json={
            'spaceId': space_id, 'status': 'current', 'title': title, 'parentId': parent,
            'body': {'representation': 'storage', 'value': body}})['id']

    def update_page(self, *, page_id, title, body):
        version = self.call(method='GET', path=f'/api/v2/pages/{page_id}')['version']['number']
        self.call(method='PUT', path=f'/api/v2/pages/{page_id}', json={
            'id': page_id, 'status': 'current', 'title': title,
            'body': {'representation': 'storage', 'value': body},
            'version': {'number': version + 1, 'message': 'Published from Markdown'}})

    def upload(self, *, page_id, name, path):
        with open(path, 'rb') as file:
            self.call(method='PUT', path=f'/rest/api/content/{page_id}/child/attachment',
                      headers={'X-Atlassian-Token': 'no-check'}, files={'file': (name, file)},
                      data={'minorEdit': 'true'})

    def rendered(self, *, page_id):
        return self.call(method='GET', path=f'/rest/api/content/{page_id}', params={'expand': 'body.view,children.attachment'})


def verify(*, confluence, page_id, page):
    """Reads the published page back and checks what the conversion promised."""
    content = confluence.rendered(page_id=page_id)
    view = content['body']['view']['value']
    ids = {html.unescape(i) for i in re.findall(r'id="([^"]+)"', view)}
    missing = [h for h in (html.unescape(h) for h in re.findall(r'href="#([^"]+)"', view)) if h not in ids]
    attached = {a['title'] for a in content['children']['attachment']['results']}
    problems = []
    if missing:
        problems.append(f'jump links without a target: {missing[:5]}')
    if set(page.images) - attached:
        problems.append(f'images not attached: {sorted(set(page.images) - attached)}')
    if view.count('<img') < len(re.findall(r'<ac:image', page.body)):
        problems.append('fewer images rendered than the page uses')
    if '</em><em>' in view or re.search(r'(?i)unknown macro|error rendering', view):
        problems.append('broken formatting or macro errors in the rendered page')
    if problems:
        raise PublishError(f'"{page.title}" published, but: ' + '; '.join(problems))
    links = len(re.findall(r'href="#', view))
    return f'{links} jump links resolve, {len(page.images)} images attached'


def main():
    parser = argparse.ArgumentParser(description='Publish Markdown docs to Confluence.')
    parser.add_argument('config', help='JSON config: base, space, parent, docs (and optionally toc)')
    parser.add_argument('--dry-run', action='store_true',
                        help='convert and check only; with credentials, also show which pages would change')
    parser.add_argument('--offline', action='store_true',
                        help='convert and check only, without contacting Confluence (implies --dry-run)')
    parser.add_argument('--out', help='write each converted page (storage XHTML) into this directory')
    parser.add_argument('--text-only', action='store_true', help='update page text without uploading images')
    parser.add_argument('--verify', action='store_true', help='after publishing, read each page back and check it')
    args = parser.parse_args()

    config = load_config(path=args.config)
    pages = convert_all(config=config)
    for page in pages.values():
        print(f'{os.path.basename(page.path)}: "{page.title}", {len(page.anchors)} headings, '
              f'{len(page.images)} images, {len(page.body):,} chars')
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, os.path.basename(page.path)[:-3] + '.storage.xhtml'), 'w') as file:
                file.write(page.body)

    if args.offline:
        print('[offline] converted and checked; Confluence was not contacted')
        return
    try:
        auth = credentials()
    except PublishError:
        if args.dry_run:
            print('[dry run] converted offline; no credentials, so existing pages were not checked')
            return
        raise
    confluence = Confluence(base=config.base, auth=auth)
    space_id = confluence.space_id(key=config.space)
    for page in pages.values():
        existing = confluence.find_page(space_id=space_id, title=page.title)
        if existing and str(existing.get('parentId')) != config.parent:
            raise PublishError(f'A page titled "{page.title}" already exists elsewhere in {config.space} '
                               f'(id {existing["id"]}); refusing to overwrite it')
        uploads = 'no image uploads' if args.text_only else f'{len(page.images)} images'
        action = f'update page {existing["id"]}' if existing else 'create page'
        print(f'{"[dry run] would " if args.dry_run else ""}{action}: "{page.title}" + {uploads}')
        if args.dry_run:
            continue
        page_id = existing['id'] if existing else confluence.create_page(
            space_id=space_id, parent=config.parent, title=page.title, body='<p>Publishing…</p>')
        if not args.text_only:
            for name, path in sorted(page.images.items()):
                confluence.upload(page_id=page_id, name=name, path=path)
        confluence.update_page(page_id=page_id, title=page.title, body=page.body)
        print(f'  published: {config.base}/spaces/{config.space}/pages/{page_id}')
        if args.verify:
            print(f'  verified: {verify(confluence=confluence, page_id=page_id, page=page)}')


if __name__ == '__main__':
    try:
        main()
    except PublishError as error:
        print(f'✗ {error}', file=sys.stderr)
        sys.exit(1)

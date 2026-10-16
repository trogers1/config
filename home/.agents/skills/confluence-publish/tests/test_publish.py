"""Runs publish.py as the skill does, offline, on small docs written like real ones.

    uv run --with pytest==8.3.3 --with markdown==3.7 --with requests==2.32.3 \
        pytest ~/.agents/skills/confluence-publish/tests
"""

import json
import os
import re
import subprocess
import sys

import pytest

SCRIPT = os.path.join(os.path.dirname(__file__), '..', 'scripts', 'publish.py')
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')

GUIDE = """# Sales guide

Intro with a [dashboard link](https://example.com/admin/) and the [customer guide](customer.md).

<!-- toc -->

## Customers and contracts

### Set up a new customer

1. Go to **New organization**.

   ![New organization](images/new-org.png)

2. Fill in the form:
   - **Name**: can't be changed later.
   - **Tier**: the product.

> ⚠️ **Without a quota, calls are refused.** Add one first.

See [renewals](#renew-a-customer) and the [roles](customer.md#what-each-role-can-do).

### Renew a customer

_A caption with **bold** inside._

| Quota Admin | Org Manager |
|---|---|
| ![Quota](images/quota.png) | ![Org](images/org.png) |
"""

CUSTOMER = """# Customer guide

> **Tip:** keep two admins.

## What each role can do

**Org: Viewer**
- See members.
- See usage.
"""


def write_docs(*, root, guide=GUIDE, customer=CUSTOMER, config=None):
    os.makedirs(os.path.join(root, 'images'), exist_ok=True)
    for name in ['new-org.png', 'quota.png', 'org.png']:
        with open(os.path.join(root, 'images', name), 'wb') as file:
            file.write(PNG)
    with open(os.path.join(root, 'guide.md'), 'w') as file:
        file.write(guide)
    with open(os.path.join(root, 'customer.md'), 'w') as file:
        file.write(customer)
    config = config or {'base': 'https://example.atlassian.net/wiki', 'space': 'LM', 'parent': '123',
                        'docs': ['guide.md', 'customer.md']}
    path = os.path.join(root, 'confluence.json')
    with open(path, 'w') as file:
        json.dump(config, file)
    return path


def publish(*, config, out):
    return subprocess.run([sys.executable, SCRIPT, config, '--offline', '--out', out],
                          capture_output=True, text=True)


def converted(*, tmp_path, **docs):
    config = write_docs(root=str(tmp_path / 'docs'), **docs)
    out = str(tmp_path / 'out')
    result = publish(config=config, out=out)
    assert result.returncode == 0, result.stderr
    return {name: open(os.path.join(out, f'{name}.storage.xhtml')).read() for name in ['guide', 'customer']}, result


def test_converts_a_guide_to_confluence_storage(tmp_path):
    pages, result = converted(tmp_path=tmp_path)
    # Compare markup without the spaces the converter leaves between tags.
    guide, customer = (re.sub(r'>\s+<', '><', pages[name]) for name in ['guide', 'customer'])
    assert '"Sales guide", 3 headings, 3 images' in result.stdout
    assert '[offline]' in result.stdout

    # One table of contents, at the configured default levels.
    assert guide.count('ac:name="toc"') == 1
    assert '<ac:parameter ac:name="maxLevel">3</ac:parameter>' in guide
    # Headings carry GitHub-slug anchors, and jump links point at them.
    assert '<ac:parameter ac:name="">renew-a-customer</ac:parameter>' in guide
    assert '<ac:link ac:anchor="renew-a-customer"><ac:link-body>renewals</ac:link-body></ac:link>' in guide
    # Cross-doc links target the other page by title, with or without an anchor.
    assert '<ac:link ac:anchor="what-each-role-can-do"><ri:page ri:content-title="Customer guide" />' in guide
    assert '<ac:link><ri:page ri:content-title="Customer guide" /><ac:link-body>customer guide' in guide
    # External links are untouched.
    assert '<a href="https://example.com/admin/">dashboard link</a>' in guide
    # Images become attachments; those in table cells are narrower.
    assert '<ac:image ac:alt="New organization" ac:width="760"><ri:attachment ri:filename="new-org.png" />' in guide
    assert '<ac:image ac:alt="Quota" ac:width="360">' in guide
    # The numbered step keeps its image and its nested list (Prettier-style indents).
    step = re.search(r'<ol>.*?</ol>', guide).group(0)
    assert 'new-org.png' in step
    assert '<ul><li><strong>Name</strong>' in step
    # Quotes become panels.
    assert '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p><strong>Without a quota' in guide
    assert '<ac:structured-macro ac:name="info">' in customer
    # Bold inside an underscore caption stays inside the italics.
    assert '<em>A caption with <strong>bold</strong> inside.</em>' in guide
    # A list straight after a bold line is a real list, and no paragraph holds a line break.
    assert '<li>See members.</li>' in customer
    assert '\n' not in re.sub(r'<pre>.*?</pre>', '', pages['guide'], flags=re.S)


@pytest.mark.parametrize('change, message', [
    ({'guide': GUIDE.replace('(#renew-a-customer)', '(#renewals)')}, 'jump link #renewals has no matching heading'),
    ({'guide': GUIDE.replace('customer.md#what-each-role-can-do', 'customer.md#missing')},
     'links to #missing in customer.md, which has no such heading'),
    ({'guide': GUIDE + '\n[Other](other.md)\n'}, 'links to other.md, which is not in the config'),
    ({'guide': GUIDE.replace('images/quota.png', 'images/nope.png')}, 'image not found: images/nope.png'),
    ({'customer': CUSTOMER.replace('# Customer guide', '# Sales guide')}, 'Two docs have the same "# Title"'),
    ({'guide': GUIDE.replace('# Sales guide\n', 'Sales guide\n')}, 'must start with a "# Title" line'),
    ({'guide': GUIDE.replace('<!-- toc -->', '<!-- toc -->\n\n<!-- toc -->')}, 'more than one <!-- toc --> marker'),
    ({'guide': GUIDE + '\n### Renew a customer\n'}, 'two headings with the anchor #renew-a-customer'),
    ({'config': {'base': 'https://example.atlassian.net/wiki', 'space': 'LM', 'parent': '123',
                 'docs': ['guide.md', 'customer.md'], 'folder': 'x'}}, 'Unknown config keys: folder'),
    ({'config': {'base': 'https://example.atlassian.net/wiki', 'space': 'LM', 'parent': 'Documentation',
                 'docs': ['guide.md', 'customer.md']}}, '"parent" must be a numeric folder or page id'),
])
def test_refuses_docs_it_cannot_publish_faithfully(tmp_path, change, message):
    config = write_docs(root=str(tmp_path / 'docs'), **change)
    result = publish(config=config, out=str(tmp_path / 'out'))
    assert result.returncode == 1
    assert message in result.stderr

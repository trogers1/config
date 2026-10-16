---
name: confluence-publish
description: >-
  Publish Markdown docs (with local screenshots) as Confluence pages under a folder or parent page, and republish them after edits. Use when the user wants docs added to or updated in Confluence. Converts tables, lists, quote panels, images, jump links, cross-doc links and a table of contents; dry-runs first and needs approval before publishing.
---

# Publish Markdown to Confluence

The Markdown files are the source of truth. The script converts them to Confluence storage format and creates or updates one page per file, with its images uploaded as attachments. Every publish **replaces the page body**, so edits made directly in Confluence are lost (comments are kept). Say so when you first publish.

```sh
uv run ~/.agents/skills/confluence-publish/scripts/publish.py <config.json> --dry-run --out <scratch-dir>
uv run ~/.agents/skills/confluence-publish/scripts/publish.py <config.json> --verify
uv run ~/.agents/skills/confluence-publish/scripts/publish.py <config.json> --text-only --verify
```

Run `--help` for every option. `uv` provides the pinned dependencies; install nothing else.

## Workflow

1. **Find or write the config.** Look for an existing config next to the docs first (a JSON file listing them). Otherwise ask the user for the Confluence location: a folder or page URL gives the space key and the numeric parent id (`.../spaces/<SPACE>/folder/<id>/...` or `.../pages/<id>/...`). Write the config next to the docs.
2. **Dry run.** Use `--dry-run --out <scratch-dir>`. It converts every doc and fails loudly on problems: broken jump links, links to docs not in the config, missing images, duplicate titles or anchors, invalid output. With credentials it also says which pages it would create or update. Fix the docs, not the script, unless the script is wrong.
3. **Get approval.** Show the user the pages that will be created or updated (titles, location, image counts), and ask before publishing. Publishing is visible to everyone who can read the space. Approval covers that publish; ask again for a later one unless the user has said to keep republishing as you edit.
4. **Publish with `--verify`.** It reads each page back from Confluence and checks that jump links resolve, images are attached and rendered, and nothing failed to render. Use `--text-only` when no image has changed: it skips the uploads and takes seconds.
5. **Report** the page links from the output. Don't claim a page is updated until the command has printed `published` and `verified` for it.

## Config

```json
{
	"base": "https://lightcast-io.atlassian.net/wiki",
	"space": "LM",
	"parent": "5362974732",
	"docs": ["internal-guide.md", "customer-guide.md"],
	"toc": { "minLevel": 2, "maxLevel": 3 }
}
```

- `parent` is a folder or page id. New pages are created under it. A doc's page is found by its title anywhere in the space. If that page sits under a different parent, the script refuses to overwrite it.
- `docs` paths are relative to the config file. Each doc's `# Title` line is its page title. **Renaming a title creates a new page**, and the old one stays: tell the user to delete or move it.
- `toc` is optional. It sets which heading levels the table of contents shows.

## Credentials

The script reads `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN`, or else the macOS Keychain item `confluence-api-token` (its account is the email). **Never ask the user to paste a token into the chat.** If there are no credentials, give them these steps to run themselves:

1. Create a token at id.atlassian.com → Security → API tokens.
2. Store it. The command prompts for the token, so it never appears in chat or shell history:

```sh
security add-generic-password -s confluence-api-token -a you@example.com -w
```

If the user pastes a token anyway, don't write it to any file in a repo. Suggest they move it to the Keychain, and revoke it when finished.

## Writing docs that convert well

- **One line per paragraph or list item.** Confluence shows a line break inside a paragraph as a hard break. The script joins stray breaks, but unwrapped source avoids surprises.
- **Lists:** write them as usual (Prettier or GitHub style). The script re-indents them for its converter.
- **Headings become anchors** with GitHub's slugs, so `[text](#heading-slug)` jump links and `[text](other.md#heading-slug)` cross-doc links work as they do on GitHub. A doc can link only to docs in the same config.
- **`<!-- toc -->`** (at most one per doc) becomes Confluence's table of contents. Prefer it over a hand-kept jump list, and use heading levels for grouping (for example `##` groups, `###` tasks).
- **`>` quotes** become info panels, or warning panels when they contain ⚠️.
- **Images** must be local files, referenced relative to the doc. Attachment names are file names, so two different images in one doc can't share a name. Images in table cells render narrower, so side-by-side screenshots fit.
- **Bold inside italics:** use `_italic **bold**_`, not `*italic **bold***`, which the converter splits apart. Prettier writes the safe form.
- External links stay as links. Code blocks become plain preformatted blocks.

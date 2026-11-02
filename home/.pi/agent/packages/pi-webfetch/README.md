# Taylor Pi Webfetch

A tiny Pi package that adds a single `webfetch` tool.

## What it does

- accepts one `http` or `https` URL
- loads it in headless Chromium via Playwright
- waits for the page to render with JavaScript enabled
- returns sanitized, content-focused HTML rather than the full noisy DOM
- truncates large output and saves the full HTML to a temp file
- relies on Pi's configured guard policy for any approval; it does not prompt or remember origin approvals itself

## What it intentionally does not do

- no clicking, form filling, or arbitrary browsing flows
- not intended to preserve full page structure or scripts exactly
- no multi-page crawling
- no screenshotting
- no cookie/session persistence across calls

## Install

This repo symlinks the package into `~/.pi/agent/packages/pi-webfetch`, but local-path Pi packages still need their runtime dependencies installed.

```bash
cd ~/.pi/agent/packages/pi-webfetch
npm install
npx playwright install chromium
```

## Usage

Ask Pi to fetch a page, for example:

- `Fetch https://example.com and inspect the rendered HTML`
- `Use webfetch on https://news.ycombinator.com and look for the login form`

Tool parameters:

- `url` - required URL
- `waitUntil` - `domcontentloaded`, `load`, or `networkidle`
- `timeoutMs` - capped at 30000
- `settleMs` - extra client-side settle time after navigation, capped at 5000

## Notes

`webfetch` does not maintain per-origin approvals or show its own confirmation prompt. Configure Pi Guard if this tool needs approval decisions; without Pi Guard, webfetch fetches valid URLs without prompting.

If Chromium is not installed yet, the tool returns a message telling you to run:

```bash
npx playwright install chromium
```

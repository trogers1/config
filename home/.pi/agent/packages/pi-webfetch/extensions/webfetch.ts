import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { chromium } from "playwright";

const APPROVED_ORIGIN_ENTRY = "webfetch-approved-origin";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 750;
const MAX_SETTLE_MS = 5_000;
const WAIT_UNTIL_VALUES = ["domcontentloaded", "load", "networkidle"] as const;

type WaitUntil = (typeof WAIT_UNTIL_VALUES)[number];

type ApprovedOriginEntry = {
  origin?: string;
};

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}

function parseFetchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("webfetch only supports http and https URLs");
  }

  return url;
}

function restoreApprovedOrigins(ctx: ExtensionContext): Set<string> {
  const approved = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== APPROVED_ORIGIN_ENTRY) continue;
    const origin = (entry.data as ApprovedOriginEntry | undefined)?.origin;
    if (typeof origin === "string" && origin.length > 0) approved.add(origin);
  }
  return approved;
}

export default function webfetchExtension(pi: ExtensionAPI) {
  let approvedOrigins = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    approvedOrigins = restoreApprovedOrigins(ctx);
  });

  pi.registerTool(
    defineTool({
      name: "webfetch",
      label: "Webfetch",
      description:
        "Fetch a single URL in headless Chromium with JavaScript enabled and return sanitized, content-focused HTML. Keep usage narrow: inspect one supplied page, not broad crawling or browsing.",
      promptSnippet: "Fetch one user-supplied web page with JS enabled and inspect sanitized, content-focused HTML.",
      promptGuidelines: [
        "Use webfetch when the user explicitly wants content from a URL that may require JavaScript rendering.",
        "Use webfetch for a single page fetch, not for broad site crawling or repeated navigation.",
      ],
      parameters: Type.Object({
        url: Type.String({ description: "The http or https URL to fetch" }),
        waitUntil: Type.Optional(
          StringEnum(WAIT_UNTIL_VALUES, { description: "When navigation should be considered ready" }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({ description: `Navigation timeout in milliseconds (max ${MAX_TIMEOUT_MS})` }),
        ),
        settleMs: Type.Optional(
          Type.Number({ description: `Extra time to wait after navigation for client-side rendering (max ${MAX_SETTLE_MS})` }),
        ),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const url = parseFetchUrl(params.url);
        const waitUntil = (params.waitUntil ?? "domcontentloaded") as WaitUntil;
        const timeoutMs = clamp(params.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const settleMs = clamp(params.settleMs, DEFAULT_SETTLE_MS, MAX_SETTLE_MS);

        if (!approvedOrigins.has(url.origin)) {
          if (!ctx.hasUI) {
            return {
              content: [
                {
                  type: "text",
                  text: `webfetch requires interactive approval before first access to ${url.origin}. Re-run this in interactive Pi and approve the origin.`,
                },
              ],
              details: { url: url.toString(), origin: url.origin, approved: false },
            };
          }

          const approved = await ctx.ui.confirm(
            "Allow webfetch origin?",
            `Allow the webfetch tool to access:\n${url.origin}\n\nRequested URL:\n${url.toString()}\n\nThis approval is remembered for the current session.`,
          );

          if (!approved) {
            return {
              content: [{ type: "text", text: `webfetch was not approved for origin: ${url.origin}` }],
              details: { url: url.toString(), origin: url.origin, approved: false },
            };
          }

          approvedOrigins.add(url.origin);
          pi.appendEntry(APPROVED_ORIGIN_ENTRY, { origin: url.origin });
        }

        let browser;
        try {
          browser = await chromium.launch({ headless: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text:
                  `Unable to launch Playwright Chromium. ${message}\n\nIf the package dependencies are installed, try:\ncd ~/.pi/agent/packages/pi-webfetch && npx playwright install chromium`,
              },
            ],
            details: { url: url.toString(), origin: url.origin, launchError: true },
          };
        }

        try {
          const context = await browser.newContext({ javaScriptEnabled: true });
          const page = await context.newPage();

          await page.route("**/*", async (route) => {
            const resourceType = route.request().resourceType();
            if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
              await route.abort();
              return;
            }
            await route.continue();
          });

          const response = await page.goto(url.toString(), {
            waitUntil,
            timeout: timeoutMs,
          });

          if (settleMs > 0) {
            await page.waitForTimeout(settleMs);
          }

          const extracted = await page.evaluate(() => {
            const contentRoot =
              document.querySelector("main") ??
              document.querySelector("article") ??
              document.querySelector("[role='main']") ??
              document.body ??
              document.documentElement;

            const clone = contentRoot.cloneNode(true) as HTMLElement;

            const removeSelectors = [
              "script",
              "style",
              "noscript",
              "template",
              "svg",
              "canvas",
              "iframe",
              "video",
              "audio",
              "picture",
              "source",
              "object",
              "embed",
              "form",
              "button",
              "input",
              "select",
              "option",
              "textarea",
              "nav",
              "header",
              "footer",
              "aside",
              "dialog",
              "menu",
              "menuitem",
              "link",
              "meta",
            ];

            clone.querySelectorAll(removeSelectors.join(",")).forEach((node) => node.remove());

            clone.querySelectorAll("img").forEach((img) => {
              const alt = img.getAttribute("alt")?.trim();
              if (alt) {
                const replacement = document.createElement("p");
                replacement.textContent = `[Image: ${alt}]`;
                img.replaceWith(replacement);
              } else {
                img.remove();
              }
            });

            clone.querySelectorAll("a").forEach((anchor) => {
              const href = anchor.getAttribute("href");
              if (!href) return;
              try {
                anchor.setAttribute("href", new URL(href, document.baseURI).toString());
              } catch {
                anchor.removeAttribute("href");
              }
            });

            clone.querySelectorAll("*").forEach((element) => {
              const hidden = element.getAttribute("hidden") !== null || element.getAttribute("aria-hidden") === "true";
              if (hidden) {
                element.remove();
                return;
              }

              for (const attr of Array.from(element.attributes)) {
                const keepHref = element.tagName === "A" && attr.name === "href";
                if (!keepHref) element.removeAttribute(attr.name);
              }
            });

            const isMeaningful = (node: Element): boolean => {
              if (["BR", "HR"].includes(node.tagName)) return true;
              if (node.children.length > 0) return true;
              return (node.textContent ?? "").replace(/\s+/g, " ").trim().length > 0;
            };

            Array.from(clone.querySelectorAll("*")).reverse().forEach((element) => {
              if (!isMeaningful(element)) element.remove();
            });

            const html = clone.outerHTML.replace(/\n{3,}/g, "\n\n").trim();
            const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
            return {
              contentHtml: html,
              contentTextLength: text.length,
              rootTag: clone.tagName.toLowerCase(),
            };
          });

          const title = await page.title();
          const finalUrl = page.url();
          const status = response?.status() ?? null;

          const body = [
            `URL: ${url.toString()}`,
            `Final URL: ${finalUrl}`,
            `Title: ${title || "(none)"}`,
            `HTTP status: ${status ?? "unknown"}`,
            `Content root: <${extracted.rootTag}>`,
            `Content text length: ${extracted.contentTextLength}`,
            "",
            extracted.contentHtml,
          ].join("\n");

          const truncation = truncateHead(body, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          const details: Record<string, unknown> = {
            url: url.toString(),
            finalUrl,
            origin: url.origin,
            title,
            status,
            waitUntil,
            timeoutMs,
            settleMs,
            contentRootTag: extracted.rootTag,
            contentTextLength: extracted.contentTextLength,
          };

          let output = truncation.content;
          if (truncation.truncated) {
            const tempDir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
            const tempFile = join(tempDir, "page.html");
            await withFileMutationQueue(tempFile, async () => {
              await writeFile(tempFile, body, "utf8");
            });

            details.truncation = truncation;
            details.fullOutputPath = tempFile;
            output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
          }

          await context.close();

          return {
            content: [{ type: "text", text: output }],
            details,
          };
        } finally {
          await browser.close();
        }
      },
    }),
  );
}

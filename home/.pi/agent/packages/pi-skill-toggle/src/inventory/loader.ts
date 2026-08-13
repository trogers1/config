import { dirname } from "node:path";
import type { FileSystem } from "../ports/fs.ts";
import type { FrontmatterCodec } from "../frontmatter/parser.ts";
import type { SkillLocator } from "../discovery/skill-locator.ts";
import type { SkillRecord } from "../types.ts";
import { deriveSkillMetadata } from "../frontmatter/validation.ts";
import { classifyInvocationMode } from "./classifier.ts";

export interface SkillInventory {
  load(cwd: string): Promise<SkillRecord[]>;
}

export class DefaultSkillInventory implements SkillInventory {
  private readonly locator: SkillLocator;
  private readonly fs: FileSystem;
  private readonly codec: FrontmatterCodec;

  constructor({
    locator,
    fs,
    codec,
  }: {
    locator: SkillLocator;
    fs: FileSystem;
    codec: FrontmatterCodec;
  }) {
    this.locator = locator;
    this.fs = fs;
    this.codec = codec;
  }

  async load(cwd: string): Promise<SkillRecord[]> {
    const located = await this.locator.findSkillFiles(cwd);
    const records: SkillRecord[] = [];

    for (const file of located) {
      try {
        const raw = await this.fs.readFile(file.filePath);
        const doc = this.codec.parse(raw);
        const metadata = deriveSkillMetadata({ filePath: file.filePath, doc });
        records.push({
          id: file.filePath,
          name: metadata.name,
          description: metadata.description,
          filePath: file.filePath,
          baseDir: dirname(file.filePath),
          source: file.source,
          editable:
            file.editable &&
            doc.hasFrontmatter &&
            !metadata.diagnostics.some((d) => d.severity === "error"),
          mode: classifyInvocationMode(doc),
          diagnostics: metadata.diagnostics,
        });
      } catch (error) {
        records.push({
          id: file.filePath,
          name: file.filePath.split("/").at(-2) ?? file.filePath,
          description: "",
          filePath: file.filePath,
          baseDir: dirname(file.filePath),
          source: file.source,
          editable: false,
          mode: "agent-invocable",
          diagnostics: [
            {
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        });
      }
    }

    return records.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath),
    );
  }
}

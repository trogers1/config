import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

it.each([
  { command: "head ordinary -100", deniedName: "-100", protected: false },
  { command: "head ordinary -100", deniedName: "-100", protected: true },
  { command: "tail ordinary -100", deniedName: "-100", protected: false },
  { command: "tail ordinary -100", deniedName: "-100", protected: true },
  { command: "cat ordinary -n", deniedName: "-n", protected: true },
  { command: "cat ordinary -n", deniedName: "-n", protected: false },
  { command: "head ordinary -n 2", deniedName: "-n", protected: true },
  { command: "head ordinary -n 2", deniedName: "-n", protected: false },
  { command: "head ordinary -n 2", deniedName: "2", protected: false },
  { command: "cat ordinary --", deniedName: "--", protected: true },
  { command: "cat ordinary --", deniedName: "--", protected: false },
  { command: "head ordinary --", deniedName: "--", protected: true },
  { command: "head ordinary --", deniedName: "--", protected: false },
])(
  "checks trailing filename $deniedName in $command (protected=$protected)",
  async ({ command, deniedName, protected: protectedPath }) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "guard-reader-options-"),
    );
    const config = path.join(root, "profiles.jsonc");
    const deniedPath = path.join(root, deniedName);
    for (const filename of ["ordinary", "-n", "-100", "2", "--", "-allowed"]) {
      fs.writeFileSync(path.join(root, filename), "fixture");
    }
    fs.writeFileSync(
      config,
      JSON.stringify({
        defaultProfile: "operands",
        profiles: {
          operands: {
            description: "BSD option termination regression",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: "*", decision: "allow" }] },
            readPaths: [
              { pattern: `${root}/**`, decision: "allow" },
              ...(!protectedPath
                ? [{ pattern: deniedPath, decision: "deny" }]
                : []),
            ],
            writePaths: [
              { pattern: path.join(root, "ordinary"), decision: "deny" },
            ],
            protectedPathRules: protectedPath
              ? [{ pattern: deniedPath, decision: "deny" }]
              : [],
            sandbox: false,
          },
        },
      }),
    );
    const previous = process.env.PI_GUARD_PROFILE_CONFIG;
    process.env.PI_GUARD_PROFILE_CONFIG = config;
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    try {
      await harness.start();
      // Prefix options/counts and prefix -- remain syntax, not filenames.
      for (const allowed of [
        "cat ordinary",
        "cat -n ordinary",
        "head -n 2 ordinary",
        "tail -n 2 ordinary",
        "cat -- -allowed",
        "head -- -allowed",
      ]) {
        expect(
          await harness.callTool({
            toolName: "bash",
            input: { command: allowed },
          }),
          allowed,
        ).toBeUndefined();
      }
      const result = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(result?.block).toBe(true);
      // The absolute path is absent from the raw relative command. This proves
      // the intended filename, not an unrelated option or write gate, blocked it.
      expect(result?.reason).toContain(`\n${deniedPath}\n`);
    } finally {
      await harness.shutdown();
      if (previous === undefined) delete process.env.PI_GUARD_PROFILE_CONFIG;
      else process.env.PI_GUARD_PROFILE_CONFIG = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("gates proven Bash readers by read grants without granting mutation or output access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-operands-"));
  const config = path.join(root, "profiles.jsonc");
  const target = path.join(root, "read-only");
  fs.mkdirSync(target);
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultProfile: "operands",
      profiles: {
        operands: {
          description: "Read-only operand regression",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "*", decision: "allow" }] },
          readPaths: [
            { pattern: `${target}/**`, decision: "allow" },
            { pattern: target, decision: "allow" },
            {
              pattern: `${target}/no-read`,
              contexts: ["read"],
              decision: "deny",
            },
            { pattern: "-secret", decision: "deny" },
            { pattern: "-100", decision: "deny" },
          ],
          writePaths: [
            { pattern: `${target}/**`, decision: "deny" },
            { pattern: target, decision: "deny" },
          ],
          protectedPathRules: [
            { pattern: `${target}/secret`, decision: "deny" },
          ],
          sandbox: false,
        },
      },
    }),
  );
  const previous = process.env.PI_GUARD_PROFILE_CONFIG;
  process.env.PI_GUARD_PROFILE_CONFIG = config;
  const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
  try {
    await harness.start();
    for (const command of [
      `find ${target} -maxdepth 1 -name '*RI-456*'; ls ${target}; cat ${target}/ordinary`,
      `find ${target} -type f -print`,
      `cat -n ${target}/ordinary`,
      `cat -- ${target}/ordinary`,
      `printf safe | head -100`,
      `printf safe | tail -100`,
      `head -100 ${target}/ordinary`,
      `tail -100 ${target}/ordinary`,
      `printf safe | head -100 ${target}/ordinary`,
      `printf safe | tail -100 ${target}/ordinary`,
      `head -100 -- ${target}/ordinary`,
      `tail -100 -- ${target}/ordinary`,
      `head -n 2 ${target}/ordinary`,
      `tail -c 4 ${target}/ordinary`,
      `head --lines=2 ${target}/ordinary`,
      `tail -n2 -- ${target}/ordinary`,
      `ls ${target}/no-read`,
    ]) {
      expect(
        await harness.callTool({ toolName: "bash", input: { command } }),
        command,
      ).toBeUndefined();
    }
    for (const command of [
      `ls ${target} > ${target}/output`,
      `find ${target} -delete`,
      `find ${target} -exec rm {} \\;`,
      `find ${target} -execdir rm {} \\;`,
      `find ${target} -fprint ${target}/output`,
      `find ${target} -fprint0 ${target}/output`,
      `find ${target} -fprintf ${target}/output '%p'`,
      `find ${target} -unknown`,
      `ls \"$UNKNOWN\"`,
      `cat ${target}/secret`,
      `cat -n ${target}/secret ${target}/ordinary`,
      `cat -n ${target}/no-read ${target}/ordinary`,
      `cat -- -secret ${target}/ordinary`,
      `cat -- -n ${target}/secret ${target}/ordinary`,
      `head -100 ${target}/secret ${target}/ordinary`,
      `tail -100 ${target}/no-read ${target}/ordinary`,
      `printf safe | head -100 ${target}/no-read`,
      `printf safe | tail -100 ${target}/secret`,
      `head -- -100`,
      `tail -- -100`,
      `head -100 -- -100`,
      `tail -100 -- -100`,
      `cat -100 ${target}/ordinary`,
      `head -100x ${target}/ordinary`,
      `tail -100x ${target}/ordinary`,
      `head -n 2 ${target}/secret ${target}/ordinary`,
      `tail -c 4 ${target}/no-read ${target}/ordinary`,
      `head -- -secret ${target}/ordinary`,
      `tail -- -secret ${target}/ordinary`,
      `cat --unknown ${target}/ordinary`,
      `find ${target}/secret -print`,
    ]) {
      expect(
        (await harness.callTool({ toolName: "bash", input: { command } }))
          ?.block,
        command,
      ).toBe(true);
    }
  } finally {
    await harness.shutdown();
    if (previous === undefined) delete process.env.PI_GUARD_PROFILE_CONFIG;
    else process.env.PI_GUARD_PROFILE_CONFIG = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

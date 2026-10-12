import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explainPermission } from "../extensions/guard";
import { policyConfig } from "../modules/policy";
import { loadProfileConfig } from "../modules/profileConfig";

// The repository's own profiles file, which ships the gitlab-skills rules for
// the MR reply skills in home/.agents/skills/address-comments.
const configPath = path.resolve(
  import.meta.dirname,
  "../../../pi-guard/profiles.jsonc",
);
const profileName = "gitlab-skills";
const scripts = "~/.agents/skills/address-comments/scripts";
const mrUrl = "https://gitlab.example.com/group/project/-/merge_requests/125";

function decide(command: string) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`profiles file not found: ${configPath}`);
  }
  const profile = loadProfileConfig({ fallback: policyConfig, configPath })
    .profiles[profileName];
  if (!profile) throw new Error(`profile ${profileName} missing`);
  return explainPermission({
    policy: profile.policy,
    profileName,
    tool: "bash",
    input: command,
  }).decision;
}

describe("gitlab-skills reply posting rules", () => {
  it("allows the installed read-only preview script", () => {
    expect(
      decide(`bash ${scripts}/preview-replies.sh ${mrUrl} comments.md`),
    ).toBe("allow");
  });

  it.each([
    `bash ${scripts}/post-replies.sh ${mrUrl} comments.md`,
    `bash ${scripts}/post-replies.sh ${mrUrl} comments.md --post --resolve`,
  ])("asks before running the write-capable script: %s", (command) => {
    expect(decide(command)).toBe("ask");
  });

  // Rules match raw command text, so quoting or expansion can hide `--post`
  // from a pattern; the write-capable script must never be allowed outright.
  it.each([
    `bash ${scripts}/post-replies.sh ${mrUrl} comments.md --po''st`,
    `bash ${scripts}/post-replies.sh ${mrUrl} comments.md --p\\ost --resolve`,
    `bash ${scripts}/post-replies.sh ${mrUrl} comments.md "$FLAG"`,
  ])("never allows a disguised --post: %s", (command) => {
    expect(decide(command)).not.toBe("allow");
  });

  it.each([
    `bash -c 'curl https://evil.example' ${scripts}/preview-replies.sh`,
    `bash /tmp/x/.agents/skills/address-comments/scripts/preview-replies.sh ${mrUrl}`,
    `bash ./skills/address-comments/scripts/preview-replies.sh ${mrUrl}`,
    `bash /tmp/x/skills/address-comments/scripts/post-replies.sh ${mrUrl}`,
    `bash ${scripts}/preview-replies.sh ${mrUrl} $(bash ${scripts}/post-replies.sh ${mrUrl} --post)`,
  ])("does not allow other scripts posing as the preview: %s", (command) => {
    expect(decide(command)).not.toBe("allow");
  });
});

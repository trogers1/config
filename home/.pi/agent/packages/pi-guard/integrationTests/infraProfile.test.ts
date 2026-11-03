import path from "node:path";
import { describe, expect, it } from "vitest";
import { explainPermission } from "../extensions/guard";
import { policyConfig } from "../modules/policy";
import { loadProfileConfig } from "../modules/profileConfig";

const config = loadProfileConfig({
  fallback: policyConfig,
  configPath: path.resolve(
    import.meta.dirname,
    "../../../pi-guard/profiles.jsonc",
  ),
});

const commands = [
  ...["az", "gcloud", "gsutil", "bq"].flatMap((cli) => [
    cli,
    `${cli} --help`,
    `/usr/local/bin/${cli}`,
    `/usr/local/bin/${cli} --help`,
    `./${cli} --help`,
  ]),
  "az account show",
  "az vm delete --resource-group example --name example",
  "gcloud projects list",
  "gcloud compute instances delete example --zone us-central1-a",
  "gsutil cp ./example.txt gs://example-bucket/example.txt",
  "bq ls",
  "aws",
  "aws --version",
  "aws sts get-caller-identity",
  "aws --profile production --region us-east-1 ec2 terminate-instances --instance-ids i-example",
  "aws secretsmanager get-secret-value --secret-id example",
  "aws s3 cp ./example.txt s3://example-bucket/example.txt",
  "/opt/homebrew/bin/aws",
  "/usr/local/bin/aws s3 ls",
  "./aws sts get-caller-identity",
  "AWS_PROFILE=production aws sts get-caller-identity",
  "env AWS_PROFILE=production aws sts get-caller-identity",
  "echo ready && aws sts get-caller-identity",
];

describe("repository infrastructure rules", () => {
  it.each(commands)(
    "requires cloud CLI approval across inherited profiles: %s",
    (command) => {
      for (const profileName of [
        "config-maintenance",
        "config-maintenance-committer",
        "mcp",
        "mcp-committer",
        "performance-review",
        "socrates",
        "sidecar-comments",
      ]) {
        const profile = config.profiles[profileName];
        if (!profile)
          throw new Error(`Missing repository profile: ${profileName}`);
        const explanation = explainPermission({
          policy: profile.policy,
          profileName,
          tool: "bash",
          input: command,
        });
        // Read-only profiles can impose a stricter denial on command operands.
        if (profileName === "socrates") {
          expect(explanation.decision, `${profileName}: ${command}`).not.toBe(
            "allow",
          );
        } else {
          expect(explanation.decision, `${profileName}: ${command}`).toBe(
            "ask",
          );
        }
      }
    },
  );

  it("retains the Terraform mutation denial", () => {
    expect(
      explainPermission({
        policy: config.profiles.mcp.policy,
        profileName: "mcp",
        tool: "bash",
        input: "terraform apply",
      }).decision,
    ).toBe("deny");
  });
});

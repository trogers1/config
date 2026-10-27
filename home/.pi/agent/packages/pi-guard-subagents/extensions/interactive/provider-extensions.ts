import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const PROVIDER_DOCUMENTATION_BASENAMES = Object.freeze(["README.md"]);
const approvalSource = fileURLToPath(import.meta.url);
// Reviewed code only. Neither model inputs nor environment variables supply paths.
export const APPROVED_PROVIDER_EXTENSIONS = Object.freeze({
	[CLAUDE_BRIDGE_PROVIDER]: path.resolve(path.dirname(approvalSource), "../../../pi-claude/extensions/index.ts"),
} satisfies Record<typeof CLAUDE_BRIDGE_PROVIDER, string>);
const ProviderSchema = Type.Literal(CLAUDE_BRIDGE_PROVIDER);
export const ExtensionIdentitySchema = Type.Object({
	path: Type.String(),
	sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
export const ProviderExtensionSchema = Type.Object(
	{
		...ExtensionIdentitySchema.properties,
		provider: ProviderSchema,
	},
	{ additionalProperties: false },
);
type ProviderExtension = Static<typeof ProviderExtensionSchema>;
type ProviderEvents = ExtensionAPI["events"];
const RequestSchema = Type.Object(
	{ requestId: Type.String(), provider: ProviderSchema },
	{ additionalProperties: false },
);
const ResponseSchema = Type.Object({
	requestId: Type.String(),
	result: Type.Union([
		Type.Object({ status: Type.Literal("approved"), activationId: Type.String(), identity: ProviderExtensionSchema }),
		Type.Object({ status: Type.Literal("refused"), reason: Type.String() }),
	]),
});
const REQUEST_CHANNEL = "pi-guard-subagents:provider-approval-request";
const RESPONSE_CHANNEL = "pi-guard-subagents:provider-approval-response";

function readIdentityFile({ file }: { file: string }): Buffer {
	if (!fs.existsSync(file)) throw new Error(`Approved provider extension identity is unavailable: ${file}`);
	// lstat deliberately rejects links, including manifest/lockfile links.
	if (!fs.lstatSync(file).isFile()) throw new Error(`Provider identity requires a regular non-symlink file: ${file}`);
	return fs.readFileSync(file);
}

function productionFiles({ directory }: { directory: string }): string[] {
	if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory())
		throw new Error(`Provider production source requires a non-symlink directory: ${directory}`);
	return fs
		.readdirSync(directory)
		.sort()
		.flatMap((name) => {
			const file = path.join(directory, name);
			const entry = fs.lstatSync(file);
			if (entry.isDirectory()) return productionFiles({ directory: file });
			const documentation = PROVIDER_DOCUMENTATION_BASENAMES.includes(name);
			if (!entry.isFile() || (path.extname(file) !== ".ts" && !documentation))
				throw new Error(
					`Provider production source permits only directories and regular non-symlink .ts files (plus allowlisted regular documentation): ${file}`,
				);
			return documentation ? [] : [file];
		});
}

function snapshot({ provider }: { provider: Static<typeof ProviderSchema> }): ProviderExtension {
	const extension = APPROVED_PROVIDER_EXTENSIONS[provider];
	const root = path.dirname(path.dirname(extension));
	const manifestFile = path.join(root, "package.json");
	const relativeEntry = `./${path.relative(root, extension).split(path.sep).join("/")}`;
	// The manifest must expose exactly the reviewed entry, never a glob or a
	// second executable resource. Its entry directory defines the production tree.
	const ManifestSchema = Type.Object({ pi: Type.Object({ extensions: Type.Tuple([Type.Literal(relativeEntry)]) }) });
	const manifest: unknown = JSON.parse(readIdentityFile({ file: manifestFile }).toString("utf8"));
	if (!Value.Check(ManifestSchema, manifest))
		throw new Error("Provider manifest does not match the reviewed extension entry");
	const productionRoot = path.dirname(path.resolve(root, manifest.pi.extensions[0]));
	const files = [
		approvalSource,
		manifestFile,
		path.join(root, "package-lock.json"),
		...productionFiles({ directory: productionRoot }),
	].sort();
	if (!files.includes(extension)) throw new Error("Reviewed provider entry is absent from the production source tree");
	const digest = crypto.createHash("sha256");
	// Package-qualified names and byte lengths frame provider code and its shared
	// approval module unambiguously. Installed dependency contents remain trusted.
	for (const file of files) {
		// Reject symlinks/special files before canonicalizing the identity path.
		const content = readIdentityFile({ file });
		const relative = path.relative(path.dirname(root), fs.realpathSync(file)).split(path.sep).join("/");
		digest
			.update(JSON.stringify([relative, content.length]))
			.update("\0")
			.update(content);
	}
	return { provider, path: extension, sha256: digest.digest("hex") };
}

/** Explicit adapter activation grants authority only in this live Pi runtime. */
export function approveProviderExtension({
	pi,
	provider,
}: {
	pi: Pick<ExtensionAPI, "events" | "on">;
	provider: Static<typeof ProviderSchema>;
}): void {
	if (process.env.PI_SUBAGENT_DEPTH) return;
	if (!Value.Check(ProviderSchema, provider)) throw new Error("Cannot approve an unreviewed provider extension");
	const identity = Object.freeze(snapshot({ provider }));
	const activationId = crypto.randomUUID();
	// Pi owns event subscriptions and revokes them on reload, including when the
	// adapter is removed. No module singleton or inherited process state is authority.
	const unsubscribe = pi.events.on(REQUEST_CHANNEL, (data) => {
		if (!Value.Check(RequestSchema, data)) throw new Error("Invalid provider approval request");
		if (data.provider !== provider) return;
		let result: Static<typeof ResponseSchema>["result"];
		try {
			const current = snapshot({ provider });
			if (current.path !== identity.path || current.sha256 !== identity.sha256)
				throw new Error("Provider extension content changed since parent activation");
			result = { status: "approved", activationId, identity: { ...identity } };
		} catch (error) {
			result = { status: "refused", reason: String(error) };
		}
		pi.events.emit(RESPONSE_CHANNEL, { requestId: data.requestId, result } satisfies Static<typeof ResponseSchema>);
	});
	pi.on("session_shutdown", unsubscribe);
}

function selectedProvider({ model }: { model: string | null }): string | undefined {
	if (model === null) return undefined;
	const [provider, ...id] = model.split("/");
	if (provider === CLAUDE_BRIDGE_PROVIDER && !id.join("/").trim())
		throw new Error(`Child provider requires an explicit ${CLAUDE_BRIDGE_PROVIDER}/<model> selection`);
	return provider;
}

export function resolveProviderExtensions({
	model,
	events,
}: {
	model: string | null;
	events: ProviderEvents;
}): ProviderExtension[] {
	const provider = selectedProvider({ model });
	if (provider !== CLAUDE_BRIDGE_PROVIDER) return [];
	const requestId = crypto.randomUUID();
	const responses: Static<typeof ResponseSchema>[] = [];
	let invalidResponse = false;
	const unsubscribe = events.on(RESPONSE_CHANNEL, (data) => {
		if (!Value.Check(ResponseSchema, data)) {
			invalidResponse = true;
			return;
		}
		if (data.requestId === requestId) responses.push(data);
	});
	try {
		events.emit(REQUEST_CHANNEL, { requestId, provider } satisfies Static<typeof RequestSchema>);
	} finally {
		unsubscribe();
	}
	if (invalidResponse || responses.length !== 1)
		throw new Error(`Child provider extension requires exactly one active parent-approved adapter: ${provider}`);
	const response = responses[0];
	if (!response) throw new Error("Provider approval response disappeared");
	if (response.result.status === "refused") throw new Error(response.result.reason);
	validateProviderExtensions({ model, extensions: [response.result.identity] });
	return [response.result.identity];
}

export function validateProviderExtensions({
	model,
	extensions,
}: {
	model: string | null;
	extensions: ProviderExtension[];
}): void {
	const provider = selectedProvider({ model });
	if (provider === CLAUDE_BRIDGE_PROVIDER ? extensions.length !== 1 : extensions.length !== 0)
		throw new Error("Invalid guarded interactive loadout: provider extension does not match explicit model");
	for (const extension of extensions) {
		const expected = snapshot({ provider: extension.provider });
		if (extension.path !== expected.path || extension.sha256 !== expected.sha256)
			throw new Error("Invalid guarded interactive loadout: provider extension content changed or path is unapproved");
	}
}

export function requireActiveProviderExtensions({
	events,
	loadout,
}: {
	events: ProviderEvents;
	loadout: { model: string | null; providerExtensions: ProviderExtension[] };
}): void {
	const active = resolveProviderExtensions({ events, model: loadout.model });
	if (JSON.stringify(active) !== JSON.stringify(loadout.providerExtensions))
		throw new Error("Child provider identity differs from the active parent-approved adapter");
}

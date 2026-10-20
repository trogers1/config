"""Conservative discovery of an enabled, locally installed pi-guard integration.

Pi package-manager/resource-loader (0.99): project package identities replace
user identities; autoload:false deltas and resource filters can disable code.
We deliberately support only the unfiltered user local-package form. Do not
approximate Pi globs, project trust, npm/git installs, or force-enable with -e.
Profile/config validation belongs exclusively to the package-owned CLI.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess

from read_dev_config_windows import strip_jsonc, strip_trailing_commas

PACKAGE_NAME = "@trogers1/pi-guard"
VALIDATOR_NAME = "guard-profile.mjs"


def json_object(*, source, name):
    value = json.loads(strip_trailing_commas(strip_jsonc(source)))
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def settings(*, path):
    return json_object(source=path.read_text(encoding="utf-8"), name=str(path)) if path.exists() else {}


def project_settings(*, cwd, repo, ref):
    if repo is None and ref is None:
        return settings(path=Path(cwd) / ".pi/settings.json")
    if repo is None or ref is None:
        raise ValueError("Both settings repository and ref are required")
    extensions = subprocess.run(["git", "-C", repo, "ls-tree", ref, "--", ".pi/extensions"],
                                capture_output=True, text=True, check=True, timeout=15)
    if extensions.stdout:
        raise ValueError("--agent-profile cannot preflight project auto-discovered extensions in a new worktree; use an existing checkout")
    listing = subprocess.run(["git", "-C", repo, "ls-tree", ref, "--", ".pi/settings.json"],
                             capture_output=True, text=True, check=True, timeout=15)
    if not listing.stdout:
        return {}
    result = subprocess.run(["git", "-C", repo, "show", f"{ref}:.pi/settings.json"],
                            capture_output=True, text=True, check=True, timeout=15)
    return json_object(source=result.stdout, name=f"{ref}:.pi/settings.json")


def local_path(*, source, base):
    if not source.startswith(("./", "../", "/", "~/")):
        # Pi also treats unrecognized sources (e.g. 'policy') as local.
        # Never silently skip one: it could alias and disable the user guard.
        raise ValueError(f"--agent-profile supports only explicit local package paths; unsupported/ambiguous source: {source}")
    return (base / Path(source).expanduser()).resolve()


def guard_packages(*, config, base):
    entries = config.get("packages", [])
    if not isinstance(entries, list):
        raise ValueError("Pi settings packages must be an array")
    found = []
    for entry in entries:
        source = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
        if not isinstance(source, str) or not source:
            raise ValueError("Invalid Pi package declaration")
        path = local_path(source=source, base=base)
        manifest_path = path / "package.json"
        if not manifest_path.is_file():
            raise ValueError(f"--agent-profile cannot identify local package declaration: {source}; expected an available package.json")
        manifest = settings(path=manifest_path)
        if manifest.get("name") == PACKAGE_NAME:
            found.append((path, entry, manifest))
        elif "pi-guard" in source and "pi-guard-subagents" not in source:
            raise ValueError(f"Unsupported/unavailable local pi-guard installation: {source}")
    return found


def validate_profile(*, profile, cwd, repo=None, ref=None):
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi/agent").expanduser().resolve()
    user = settings(path=agent_dir / "settings.json")
    project = project_settings(cwd=cwd, repo=repo, ref=ref)
    candidates = guard_packages(config=user, base=agent_dir)
    project_candidates = guard_packages(config=project, base=Path(cwd) / ".pi")
    if project_candidates:
        raise ValueError("--agent-profile does not support project pi-guard package declarations/overrides (project trust and filters); use an unfiltered user local package")
    if len(candidates) != 1:
        raise ValueError("--agent-profile requires exactly one enabled local pi-guard package in Pi user settings; integration unavailable or ambiguous")
    package, declaration, manifest = candidates[0]
    if isinstance(declaration, dict) and ("extensions" in declaration or "autoload" in declaration):
        raise ValueError("--agent-profile does not support pi-guard extension filters/autoload overrides; integration may be disabled")
    resources = manifest.get("pi")
    if not isinstance(resources, dict) or resources.get("extensions") != ["./extensions"] or not (package / "extensions/guard.ts").is_file():
        raise ValueError("Unsupported pi-guard package extension manifest; expected ./extensions/guard.ts")
    extension_dir = package / "extensions"
    # Pi's exact manifest directory is a discovery root: its own package/index
    # entrypoints replace siblings; its own ignore files filter siblings. Reject
    # those structures instead of implementing another Pi discovery algorithm.
    # collectFilesFromPaths -> collectAutoExtensionEntries adds ignore rules
    # only from this exact root, NOT package/agent/other ancestor ignore files.
    for name in ("package.json", "index.ts", "index.js", ".gitignore", ".ignore", ".fdignore"):
        if os.path.lexists(extension_dir / name):
            raise ValueError(f"Unsupported pi-guard extension discovery structure: {extension_dir / name}; guard.ts may not be loaded")
    # Top-level resources have precedence over package resources. Reject these
    # forms rather than guessing whether a glob/directory/symlink masks guard.
    for config in (user, project):
        extensions = config.get("extensions", [])
        if not isinstance(extensions, list) or any(not isinstance(entry, str) for entry in extensions):
            raise ValueError("Pi settings extensions must be a string array")
        if any(not entry.lstrip("+-!").startswith("builtin:") for entry in extensions):
            raise ValueError("--agent-profile does not support top-level extension paths/filters; use the unfiltered local pi-guard package")
    for directory in (agent_dir / "extensions", Path(cwd) / ".pi/extensions"):
        if directory.exists():
            for entry in directory.iterdir():
                if entry.resolve().is_relative_to(package):
                    raise ValueError("--agent-profile does not support auto-discovered pi-guard aliases; package resources could be shadowed")
    validator = package / VALIDATOR_NAME
    node = shutil.which("node")
    if not validator.is_file() or not node:
        raise ValueError(f"pi-guard startup validator unavailable: node {validator}")
    validator_cwd = Path(cwd)
    if not validator_cwd.is_dir():
        # A fresh worktree cannot exist before Git mutation. The guard config
        # is user-scoped; an absolute config override is equally resolvable in
        # the source checkout. Relative overrides cannot be promised safely.
        config_override = os.environ.get("PI_GUARD_PROFILE_CONFIG", "").strip()
        if config_override and not Path(config_override).is_absolute():
            raise ValueError("New-worktree --agent-profile requires an absolute PI_GUARD_PROFILE_CONFIG path")
        if repo is None:
            raise ValueError(f"Startup profile validation directory is unavailable: {cwd}")
        validator_cwd = Path(repo)
    result = subprocess.run([node, str(validator), f"--profile={profile}", "--cwd", str(validator_cwd)],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError(f"pi-guard rejected startup profile: {result.stderr.strip() or result.stdout.strip() or result.returncode}")
    response = json.loads(result.stdout)
    if response != {"profile": profile}:
        raise ValueError("Invalid pi-guard startup validator response")

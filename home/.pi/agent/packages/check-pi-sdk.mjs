// Local packages are not reconciled by Pi. Derive SDK support from the running
// host installation, never from npm's lifecycle-injected local node_modules/.bin.
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hostName = '@earendil-works/pi-coding-agent';
const readManifest = ({ path }) => JSON.parse(readFileSync(path, 'utf8'));

function managedHost({ root }) {
  const marker = readManifest({ path: join(root, 'managed-install.json') });
  assert.equal(marker.kind, 'pi-managed-install', `Invalid managed Pi marker in ${root}`);
  assert.equal(marker.schemaVersion, 1, `Unsupported managed Pi marker in ${root}`);
  assert.equal(marker.layout, 'releases-v1', `Unsupported managed Pi layout in ${root}`);
  const version = readFileSync(join(root, 'current-version'), 'utf8').trim();
  assert.match(version, /^[a-zA-Z0-9_+-][a-zA-Z0-9._+-]*$/, `Invalid managed Pi version in ${root}`);
  const path = join(root, 'releases', version, 'node_modules', hostName, 'package.json');
  const host = readManifest({ path });
  assert.equal(host.name, hostName, `Invalid Pi package at ${path}`);
  assert.equal(host.version, version, `Managed Pi version disagrees with ${path}`);
  return host;
}

export function resolvePiHost({ env = process.env } = {}) {
  if (env.PI_MANAGED_INSTALL_ROOT) return managedHost({ root: env.PI_MANAGED_INSTALL_ROOT });
  const executableNames = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    // npm scripts prepend the SDK under test; that is not the host executable.
    if (resolve(directory).replaceAll('\\', '/').endsWith('/node_modules/.bin')) continue;
    for (const name of executableNames) {
      const executable = join(directory, name);
      if (!existsSync(executable)) continue;
      try {
        accessSync(executable, constants.X_OK);
      } catch {
        continue; // PATH lookup skips non-executable entries, just like a shell.
      }
      const actual = realpathSync(executable);
      const managedRoot = join(dirname(dirname(actual)), 'install');
      if (existsSync(join(managedRoot, 'managed-install.json'))) return managedHost({ root: managedRoot });
      // npm links its global bin directly into the installed package. Ascend
      // from that target rather than assuming `npm root -g` uses the same npm.
      let ancestor = dirname(actual);
      while (ancestor !== parse(ancestor).root) {
        const path = join(ancestor, 'package.json');
        if (existsSync(path)) {
          const manifest = readManifest({ path });
          if (manifest.name === hostName) return manifest;
        }
        ancestor = dirname(ancestor);
      }
      throw new Error(`Cannot locate the Pi host package behind ${executable}; expected an npm package link or managed Pi launcher`);
    }
  }
  throw new Error('Cannot find an installed Pi host on PATH. Install Pi or set PI_MANAGED_INSTALL_ROOT to its managed install directory.');
}

export function checkPiSdk({ cwd = process.cwd(), env = process.env } = {}) {
  const host = resolvePiHost({ env });
  const manifest = readManifest({ path: join(cwd, 'package.json') });
  assert.equal(manifest.engines?.node, host.engines.node, 'Node support must match the installed Pi host');
  const hostPackages = {
    [hostName]: host.version,
    ...Object.fromEntries(Object.entries(host.dependencies).filter(([name]) => name.startsWith('@earendil-works/pi-') || name === 'typebox')),
  };
  for (const [name, version] of Object.entries(hostPackages)) {
    assert.ok(!manifest.dependencies?.[name], `${name} is host-provided; use a wildcard peer, not a runtime dependency`);
    if (manifest.peerDependencies?.[name] !== undefined) {
      assert.equal(manifest.peerDependencies[name], '*', `${name} must remain a wildcard peer`);
    }
    if (manifest.devDependencies?.[name] !== undefined) {
      assert.equal(manifest.peerDependencies?.[name], '*', `${name} needs a wildcard peer`);
      assert.equal(manifest.devDependencies[name], version, `${name} devDependency must match installed Pi ${host.version}`);
      const installed = readManifest({ path: join(cwd, 'node_modules', name, 'package.json') });
      assert.equal(installed.version, version, `${name} local SDK is stale; run npm install`);
    }
  }
  assert.equal(manifest.devDependencies?.[hostName], host.version, 'Pin the local SDK to the installed Pi host');
  console.log(`${manifest.name}: local SDK matches Pi ${host.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkPiSdk();

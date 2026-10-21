import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sdk from './pi-guard/node_modules/@earendil-works/pi-coding-agent/package.json' with { type: 'json' };

const script = fileURLToPath(new URL('./check-pi-sdk.mjs', import.meta.url));
const write = ({ path, value }) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
const writeJson = ({ path, value }) => write({ path, value: JSON.stringify(value) });

function fixture({ t }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-sdk-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'extension');
  const manifest = {
    name: 'test-extension',
    engines: sdk.engines,
    peerDependencies: { [sdk.name]: '*' },
    devDependencies: { [sdk.name]: sdk.version },
  };
  writeJson({ path: join(cwd, 'package.json'), value: manifest });
  writeJson({ path: join(cwd, 'node_modules', sdk.name, 'package.json'), value: sdk });
  const env = { ...process.env, PATH: join(root, 'bin'), PI_MANAGED_INSTALL_ROOT: '' };
  const run = () => spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });
  return { root, cwd, manifest, env, run };
}

function managed({ root }) {
  const install = join(root, 'agent', 'install');
  writeJson({ path: join(install, 'managed-install.json'), value: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' } });
  write({ path: join(install, 'current-version'), value: `${sdk.version}\n` });
  writeJson({ path: join(install, 'releases', sdk.version, 'node_modules', sdk.name, 'package.json'), value: sdk });
  const launcher = join(root, 'agent', 'bin', 'pi');
  write({ path: launcher, value: '#!/bin/sh\n' });
  chmodSync(launcher, 0o755);
  return { install, launcher };
}

test('resolves a managed launcher through PATH without npm, skipping the local SDK bin', (t) => {
  const f = fixture({ t });
  const { launcher } = managed({ root: f.root });
  mkdirSync(f.env.PATH, { recursive: true });
  symlinkSync(launcher, join(f.env.PATH, 'pi'));
  const localBin = join(f.cwd, 'node_modules', '.bin');
  write({ path: join(localBin, 'pi'), value: '#!/bin/sh\n' });
  chmodSync(join(localBin, 'pi'), 0o755);
  f.env.PATH = [localBin, f.env.PATH].join(delimiter);
  f.env.npm_config_prefix = f.cwd;
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local SDK matches Pi/);
});

test('uses the managed root exported by the running host even without a PATH entry', (t) => {
  const f = fixture({ t });
  f.env.PI_MANAGED_INSTALL_ROOT = managed({ root: f.root }).install;
  assert.equal(f.run().status, 0);
});

test('resolves an npm-origin executable symlink to its actual host package', (t) => {
  const f = fixture({ t });
  const packageRoot = join(f.root, 'npm', 'node_modules', sdk.name);
  writeJson({ path: join(packageRoot, 'package.json'), value: sdk });
  const cli = join(packageRoot, 'dist', 'cli.js');
  write({ path: cli, value: '#!/usr/bin/env node\n' });
  chmodSync(cli, 0o755);
  mkdirSync(f.env.PATH, { recursive: true });
  symlinkSync(cli, join(f.env.PATH, 'pi'));
  assert.equal(f.run().status, 0);
});

test('fails clearly when no host is installed', (t) => {
  const f = fixture({ t });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot find an installed Pi host/);
});

test('does not silently fall back from a corrupt managed installation', (t) => {
  const f = fixture({ t });
  const { install } = managed({ root: f.root });
  f.env.PI_MANAGED_INSTALL_ROOT = install;
  write({ path: join(install, 'current-version'), value: '../escape\n' });
  assert.match(f.run().stderr, /Invalid managed Pi version/);
});

test('rejects a stale local SDK pin and unsupported Node declaration', (t) => {
  const f = fixture({ t });
  f.env.PI_MANAGED_INSTALL_ROOT = managed({ root: f.root }).install;
  const path = join(f.cwd, 'package.json');
  writeJson({ path, value: { ...f.manifest, devDependencies: { [sdk.name]: `^${sdk.version}` } } });
  assert.match(f.run().stderr, /devDependency must match installed Pi/);
  writeJson({ path, value: { ...f.manifest, engines: {} } });
  assert.match(f.run().stderr, /Node support must match/);
  writeJson({ path, value: { ...f.manifest, dependencies: { [sdk.name]: sdk.version } } });
  assert.match(f.run().stderr, /is host-provided/);
  writeJson({ path, value: f.manifest });
  writeJson({ path: join(f.cwd, 'node_modules', sdk.name, 'package.json'), value: { ...sdk, version: 'stale' } });
  assert.match(f.run().stderr, /local SDK is stale/);
});

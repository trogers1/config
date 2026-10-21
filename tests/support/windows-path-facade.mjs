// CLI-test adapter: exercise native win32 path semantics on a POSIX fixture.
// Filesystem calls translate back to the real host; the generator itself is
// unmodified and still performs real reads, writes, links, checks and cleanup.
import { createRequire, syncBuiltinESMExports } from "node:module";

if (process.platform === "win32") throw new Error("Windows path facade is only needed on POSIX hosts");
const require = createRequire(import.meta.url);
const path = require("node:path");
const fs = require("node:fs");
const nativePath = ({ value }) => typeof value === "string" ? value.replaceAll("\\", "/") : value;
for (const name of ["existsSync", "lstatSync", "mkdirSync", "readFileSync", "readdirSync", "rmSync", "writeFileSync"]) {
  const original = fs[name];
  fs[name] = (file, ...args) => original(nativePath({ value: file }), ...args);
}
const readlink = fs.readlinkSync;
fs.readlinkSync = (file, ...args) => readlink(nativePath({ value: file }), ...args).replaceAll("/", "\\");
const symlink = fs.symlinkSync;
fs.symlinkSync = (target, file, ...args) => symlink(nativePath({ value: target }), nativePath({ value: file }), ...args);
for (const name of ["basename", "dirname", "join", "relative", "sep"]) path[name] = path.win32[name];
syncBuiltinESMExports();

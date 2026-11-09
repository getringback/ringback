"use strict";
// Copy the plugin tree (for ~/.ringback/plugin/<version>/ and the npm package), without tests,
// dependencies or VCS folders. Used by plugin/join.js, join/bin and join/scripts/copy-plugin.js.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SKIP = new Set(["tests", "node_modules", ".git"]);

function copyTree(src, dest, skip = SKIP) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(from, to, new Set(["node_modules", ".git"]));
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * Install a copy of the plugin at `<base>/<version>/` (atomic: copy to a temp dir, then rename).
 * An existing copy of the same version is replaced. Returns the installed path.
 */
function installCopy(src, base, version) {
  const final = path.join(base, version);
  const tmp = path.join(base, `.${version}.${process.pid}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  copyTree(src, tmp);
  fs.rmSync(final, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  fs.renameSync(tmp, final);
  return final;
}

const defaultBase = () => path.join(process.env.RINGBACK_HOME || path.join(os.homedir(), ".ringback"), "plugin");

module.exports = { copyTree, installCopy, defaultBase, SKIP };

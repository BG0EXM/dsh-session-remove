#!/usr/bin/env node
/**
 * Build a publishable copy of this plugin.
 *
 * The package that the local desktop profile links to is `@local/dsh-session-delete`.
 * A published package needs a real, unique npm name, no `private` flag, a
 * license, and registry metadata — and renaming the source package in place
 * would break the profile dependency that currently points at it. So this
 * script copies the shipped files into `dist/<name>/` and rewrites only the
 * manifest, leaving the working install untouched.
 *
 *   node scripts/build-publish.mjs --name dsh-session-remove --author "You <you@example.com>"
 *
 * Flags:
 *   --name <pkg>        published name (default: this package's own name)
 *   --version <semver>  published version (default: the source package version)
 *   --author <string>   npm `author` field and the LICENSE holder
 *   --repo <url>        repository URL (also fills homepage/bugs)
 *   --dsh-peer <range>  @deepseek-ai/dsh peer range (default: the range this plugin was tested against)
 *   --out <dir>         output root (default: <package>/dist)
 *   --no-license        skip writing LICENSE
 *   --force             build even when the registry already has the name
 *   --no-registry-check skip the name-availability lookup
 *   --dry-run           print the produced manifest and write nothing
 */

import { readFile, writeFile, mkdir, cp, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The DSH runtime range this plugin is tested against; overridable with --dsh-peer. */
const TESTED_DSH_RANGE = ">=0.2.0-rc.2 <0.3.0";

/** Files copied verbatim into the published package. */
const SHIPPED = ["index.js", "client.js", "cordis.patch.yml", "icon.svg", "README.md"];

function parseArgs(argv) {
  const args = { license: true, registryCheck: true, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${token} requires a value`);
      return next;
    };
    switch (token) {
      case "--name": args.name = value(); break;
      case "--version": args.version = value(); break;
      case "--author": args.author = value(); break;
      case "--repo": args.repo = value(); break;
      case "--dsh-peer": args.dshPeer = value(); break;
      case "--out": args.out = value(); break;
      case "--no-license": args.license = false; break;
      case "--force": args.force = true; break;
      case "--no-registry-check": args.registryCheck = false; break;
      case "--dry-run": args.dryRun = true; break;
      default: throw new Error(`unknown flag ${JSON.stringify(token)}`);
    }
  }
  return args;
}

/**
 * Ask the public registry what this name already holds.
 * @param name - the package name to look up.
 * @returns `{ exists, versions }`, or undefined when the registry is unreachable.
 */
async function registryState(name) {
  const url = `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2F") : name}`;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.status === 404) return { exists: false, versions: [] };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return { exists: true, versions: Object.keys(body?.versions ?? {}) };
  } catch (error) {
    console.warn(`warn: could not reach the npm registry (${error.message}); skipping the name check`);
    return undefined;
  }
}

/** Run `npm pack --dry-run` so the shipped file list is visible before publishing. */
function packList(directory) {
  return new Promise((done) => {
    const child = spawn("npm", ["pack", "--dry-run"], { cwd: directory });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", () => done(undefined));
    child.on("close", (code) => done(code === 0 ? out.trim() : undefined));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8"));
  /* The source name IS the published name now; --name stays for publishing under an alias. */
  args.name ??= source.name;
  if (!NPM_NAME.test(args.name)) throw new Error(`not a valid npm package name: ${JSON.stringify(args.name)}`);

  const version = args.version ?? source.version;
  if (!SEMVER.test(version)) throw new Error(`not a semantic version: ${JSON.stringify(version)}`);

  if (args.author === undefined) console.warn("warn: no --author given; LICENSE will say \"the plugin author\" and the manifest carries no author");
  if (args.repo === undefined) console.warn("warn: no --repo given; the published manifest will carry no repository/homepage/bugs");

  if (args.registryCheck && !args.force) {
    const state = await registryState(args.name);
    if (state?.exists === false) console.log(`registry: "${args.name}" is free`);
    /* A published name is normal for every release after the first; only the exact
       version is a hard conflict, because npm will refuse to overwrite it. */
    else if (state?.exists === true) {
      if (state.versions.includes(version)) throw new Error(`npm already has ${args.name}@${version}; bump the version (or pass --force)`);
      console.log(`registry: "${args.name}" exists with ${state.versions.length} version(s); ${version} is new`);
    }
  }

  const outRoot = resolve(args.out ?? join(PACKAGE_DIR, "dist"));
  const outDir = join(outRoot, args.name.replace(/^@/, "").replace("/", "__"));

  const manifest = {
    name: args.name,
    version,
    description: source.description,
    type: "module",
    ...(args.repo === undefined ? {} : {
      homepage: `${args.repo}#readme`,
      repository: { type: "git", url: args.repo.startsWith("git+") ? args.repo : `git+${args.repo}.git` },
      bugs: { url: `${args.repo}/issues` }
    }),
    ...(args.author === undefined ? {} : { author: args.author }),
    license: "MIT",
    keywords: ["dsh", "dsh-plugin", "deepseek-harness", "cordis", "session", "delete"],
    icon: "./icon.svg",
    exports: {
      ".": "./index.js",
      "./client": "./client.js",
      "./package.json": "./package.json",
      "./locale/*.json": "./locale/*.json"
    },
    files: ["README.md", "index.js", "client.js", "cordis.patch.yml", "icon.svg", "locale/*.json"],
    engines: { node: ">=22" },
    dsh: source.dsh,
    peerDependencies: { "@deepseek-ai/dsh": args.dshPeer ?? TESTED_DSH_RANGE },
    ...(args.name.startsWith("@") ? { publishConfig: { access: "public" } } : {})
  };

  if (args.dryRun) {
    console.log(`would write ${outDir}/package.json:`);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  await mkdir(outDir, { recursive: true });
  for (const file of SHIPPED) await cp(join(PACKAGE_DIR, file), join(outDir, file));
  const locales = await readdir(join(PACKAGE_DIR, "locale"));
  await mkdir(join(outDir, "locale"), { recursive: true });
  for (const file of locales) await cp(join(PACKAGE_DIR, "locale", file), join(outDir, "locale", file));
  if (args.license) {
    const holder = args.author ?? "the plugin author";
    const year = String(new Date().getFullYear());
    await writeFile(join(outDir, "LICENSE"), `MIT License\n\nCopyright (c) ${year} ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`, "utf8");
  }
  await writeFile(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  /* The bundle contract: the module resolves, both halves exist, nothing private. */
  await access(join(outDir, manifest.exports["./client"]), constants.R_OK);
  await access(join(outDir, manifest.dsh.bundle.patch), constants.R_OK);
  if (Object.hasOwn(manifest, "private")) throw new Error("published manifests must not be private");

  console.log(`built ${manifest.name}@${manifest.version} -> ${outDir}`);
  const listed = await packList(outDir);
  if (listed !== undefined) console.log(`\nnpm pack --dry-run:\n${listed}`);
  console.log(`\nnext:\n  cd ${outDir}\n  npm publish${manifest.publishConfig?.access === "public" ? " --access public" : ""}`);
}

main().catch((error) => {
  console.error(`build-publish: ${error.message}`);
  process.exitCode = 1;
});

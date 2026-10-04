/**
 * Path resolution for the mode's verification harness.
 *
 * These probes used to live in the workspace with absolute paths baked in, which
 * was wrong twice over: they sat inside the DSH installation directory, and they
 * only ran on one machine's layout.
 *
 * The package now lives *outside* the installation, as it should — a package must
 * not sit in the app folder, because that folder is also a plausible workspace and
 * an agent working there can damage the app. So the install root can no longer be
 * inferred from this file's location (doing that resolved to `<pkg>\..\resources`,
 * which only worked while the package lived inside the install). It is discovered
 * instead, most reliable first:
 *
 *   1. `DSH_ASAR` / `DSH_EXE` — explicit override.
 *   2. `process.execPath` — when running under the harness binary, that binary
 *      *is* `<install>\DeepSeek Harness.exe`.
 *   3. The profile's parent — `<install>` is where the profile tree lives for a
 *      desktop install, and `DSH_PROFILE_DIR` names the profile.
 *   4. A bounded search of conventional locations for `resources\app.asar`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setEnvironmentData } from 'node:worker_threads';

/** `dsh-code-mode/` — the directory holding `lib/`, `probes/`, `cordis.patch.yml`. */
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROBES_DIR = path.join(PKG_DIR, 'probes');
export const LIB_DIR = path.join(PKG_DIR, 'lib');

/** True when `candidate` looks like a DSH installation root. */
function isInstallRoot(candidate) {
  return (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    fs.existsSync(path.join(candidate, 'resources', 'app.asar'))
  );
}

/** The profile this package is linked into, when it can be determined. */
function profileFromEnv() {
  const named = process.env.DSH_PROFILE_DIR;
  if (named !== undefined && fs.existsSync(named)) return named;
  const root = path.join(os.homedir(), '.dsh', 'profiles');
  if (!fs.existsSync(root)) return undefined;
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    if (fs.existsSync(path.join(candidate, 'node_modules', 'dsh-code-mode'))) return candidate;
  }
  return fs.existsSync(path.join(root, 'desktop')) ? path.join(root, 'desktop') : undefined;
}

function discoverInstallRoot() {
  const candidates = [];
  if (process.env.DSH_EXE !== undefined) candidates.push(path.dirname(process.env.DSH_EXE));
  candidates.push(path.dirname(process.execPath));
  const profile = profileFromEnv();
  if (profile !== undefined) candidates.push(path.dirname(profile));
  for (const candidate of candidates) if (isInstallRoot(candidate)) return candidate;

  // Last resort: look for the bundle in conventional places, one level deep.
  for (const drive of ['E:', 'D:', 'C:']) {
    for (const base of [`${drive}\\`, path.join(`${drive}\\`, 'tools'), path.join(`${drive}\\`, 'apps'), path.join(`${drive}\\`, 'Program Files')]) {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        const candidate = path.join(base, entry);
        if (isInstallRoot(candidate)) return candidate;
      }
    }
  }
  throw new Error(
    'probes/paths.mjs: cannot locate the DSH installation (no resources/app.asar found). ' +
      'Set DSH_ASAR (and optionally DSH_EXE), e.g. DSH_ASAR=E:\\tools\\DSH\\resources\\app.asar',
  );
}

/** The installation root, or the parent of an explicitly given asar. */
export const INSTALL_DIR =
  process.env.DSH_ASAR !== undefined ? path.dirname(path.dirname(process.env.DSH_ASAR)) : discoverInstallRoot();
/** `<install>/resources/app.asar` — the bundle that owns the `@deepseek-ai/*` packages. */
export const ASAR = process.env.DSH_ASAR ?? path.join(INSTALL_DIR, 'resources', 'app.asar');
/** The Electron binary that can run a probe with the host's module resolution. */
export const HARNESS_EXE = process.env.DSH_EXE ?? path.join(INSTALL_DIR, 'DeepSeek Harness.exe');
/** A plain Node binary shipped with the install, for probes that only import `lib/ledger.js`. */
export const NODE_EXE =
  process.env.DSH_NODE ??
  path.join(ASAR, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');

/** The profile this package is linked into. */
export function profileDir() {
  const found = profileFromEnv();
  if (found === undefined) throw new Error('no dsh profile found (set DSH_PROFILE_DIR)');
  return found;
}

/** Session logs, newest first. */
export function sessionLogs() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsonl(\.zstd)?$/.test(entry.name)) found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Install the host's profile-resolution bootstrap so a probe can import the
 * plugin modules exactly as the host does. Must be awaited before importing any
 * `lib/*.js` that uses a bare `@deepseek-ai/*` specifier.
 */
export async function installResolution() {
  const anchor = path.join(ASAR, 'dsh');
  const boot = path.join(anchor, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  const bootstrap = path.join(
    anchor,
    'node_modules',
    '@deepseek-ai',
    'dsh-app-boot',
    'lib',
    'worker',
    'profile-resolution-bootstrap.js',
  );
  const { pathToFileURL } = await import('node:url');
  const appBoot = await import(pathToFileURL(boot).href);
  const base = await appBoot.createRuntimeResolution({ installAnchor: path.join(anchor, 'package.json') });
  setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', {
    resolution: {
      ...base,
      profileDir: profileDir(),
      localPackageNames: [],
      linkedRoots: [{ name: 'dsh-code-mode', realPath: PKG_DIR }],
    },
  });
  await import(pathToFileURL(bootstrap).href);
  return { boot, bootstrap };
}

/** Report path inside the system temp dir (never the workspace). */
export function tempReport(name) {
  return path.join(os.tmpdir(), name);
}

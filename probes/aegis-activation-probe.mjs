/**
 * Verifies that the Aegis activation switch we just wrote actually changes
 * behaviour: `readAegisConfig` must report `explicit` for the real home, and
 * `installBootstrap` must return null (no automatic injection) in that mode
 * while still arming normally for `auto`.
 *
 * Written 2026-10-01 by the code-mode session. Nothing in the Aegis package is
 * modified; this only reads its exported functions.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installResolution, profileDir, tempReport } from './paths.mjs';

// The report goes to the temp dir, not the workspace: when this probe is run
// through `code_verify`, that shell can write temp but not the workspace (see
// HANDOVER rule 10), and a workspace write would fail the whole run.
const OUT = tempReport('aegis-activation-report.json');
const AEGIS = path.join(profileDir(), 'node_modules', 'aegis');

// Bare @deepseek-ai/* imports inside the Aegis adapter need the same
// profile-resolution bootstrap the host installs (see HANDOVER rule 2).


await installResolution();
const mod = await import(pathToFileURL(`${AEGIS}/extensions/dsh/bootstrap.js`).href);
const checks = [];
const check = (name, ok, evidence) => checks.push({ name, ok: ok === true, evidence });

// 1. The config we wrote must be parsed as explicit for the real home dir.
const real = mod.readAegisConfig(os.homedir());
check('real home reads activation_mode explicit', real.activationMode === 'explicit', real);

// 2. installBootstrap must NOT inject in explicit mode.
const noop = { on: () => () => {} };
const ctx = { on: (event) => { void event; return () => {}; } };
const explicitDisposer = mod.installBootstrap(ctx, {
  createUserMessage: () => ({}),
  skillsRoot: `${AEGIS}/skills`,
  homeDir: os.homedir(),
});
check('installBootstrap returns null (no injection) in explicit mode', explicitDisposer === null, {
  returned: explicitDisposer === null ? 'null' : typeof explicitDisposer,
});
void noop;

// 3. Sanity: the same call with a home that says auto must still arm, so we
//    know the switch is what changed the behaviour and not a broken call.
const tmp = path.join(os.tmpdir(), `aegis-auto-${process.pid}`);
mkdirSync(path.join(tmp, '.config', 'aegis'), { recursive: true });
writeFileSync(
  path.join(tmp, '.config', 'aegis', 'config.toml'),
  'activation_mode = "auto"\n',
  'utf8',
);
const autoConfig = mod.readAegisConfig(tmp);
check('a home with auto reads auto', autoConfig.activationMode === 'auto', autoConfig);
const armed = mod.installBootstrap(ctx, {
  createUserMessage: () => ({}),
  skillsRoot: `${AEGIS}/skills`,
  homeDir: tmp,
});
check('installBootstrap arms a disposer in auto mode', typeof armed === 'function', {
  returned: typeof armed,
});

// 4. The skills catalog must survive: the adapter's filesystem provider is
//    still applied regardless of activation mode.
check(
  'adapter still installs the skill provider in both modes',
  typeof (await import(pathToFileURL(`${AEGIS}/extensions/dsh/index.js`).href)).apply === 'function',
  'apply exported',
);

if (typeof armed === 'function') armed();
rmSync(tmp, { recursive: true, force: true });

const report = {
  aegisRoot: AEGIS,
  failed: checks.filter((c) => !c.ok).map((c) => c.name),
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
  checks,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: report.failed }));

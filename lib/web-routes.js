/**
 * The ledger console's host half: same-origin HTTP routes the settings page fetches.
 *
 * Why a host row rather than a tool: a `code_*` tool is model-facing and only exists while
 * an agent session is running and driving it, while the settings page is part of the
 * shell — it must answer whether or not a session is in flight, and it must answer for
 * ledgers of projects that are not the one being worked on. `@deepseek-ai/dsh-host-webserver`
 * is the only surface that does that, and it is the same one the wallpaper plugin uses for
 * its inventory.
 *
 * Everything that decides *what may happen* lives in `lib/ledger-admin.js` (pure Node, one
 * owner, driven by a plain-node probe). This file is deliberately thin: it parses HTTP,
 * checks same-origin, and calls that module. The three checks it does own are the ones
 * that only make sense at the HTTP boundary:
 *
 *   1. **loopback only** — the webserver serves whatever interface the composition binds,
 *      and its README says route owners enforce their own policy. This console can move
 *      ledgers, so a non-loopback peer is refused before anything else runs.
 *   2. **same-origin** — a page on another origin must not be able to drive a fetch from
 *      the user's browser into these routes. `Origin` is checked when present and
 *      `Sec-Fetch-Site` when the browser sends it.
 *   3. **a per-process token** — every mutation carries a token that only a page which
 *      read `GET <base>/ledgers` can know. It is not authentication (the route is loopback
 *      only); it is the guard against a blind cross-site POST that never saw the list.
 *
 * The row injects `webServer`, so a profile without an HTTP server simply never runs this —
 * the same shape the wallpaper plugin documents, and the reason this file never has to ask
 * whether a browser exists.
 */
import { randomBytes } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import {
  LEDGER_FILES,
  inventoryOf,
  purgeTrash,
  readLedgerFile,
  restoreTrash,
  trashLedger,
} from './ledger-admin.js';

export const name = 'code-ledger-admin';

/**
 * `webServer` is a hard dependency on purpose: without an HTTP server there is no page to
 * serve, and a row that mounts anyway would only register a route table nobody can reach.
 */
export const inject = ['webServer'];

export const Config = z.object({
  /** Turn the console off without unmounting the row. */
  enabled: z.boolean().default(true),
  /** Route prefix. Changing it means the browser half has to be rebuilt with the same value. */
  basePath: z.string().default('/code-mode'),
  /** Largest request body accepted, in bytes. Mutations are three fields wide. */
  maxBodyBytes: z.number().default(65536),
});

/** Loopback in the forms a socket actually reports. */
function isLoopback(address) {
  const value = String(address ?? '').toLowerCase();
  if (value === '::1' || value === '127.0.0.1') return true;
  if (value.startsWith('127.')) return true;
  if (value.startsWith('::ffff:127.')) return true;
  return false;
}

/** Whether two origin spellings are the same origin. */
function sameOrigin(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}

function send(res, status, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** Read a request body, refusing one larger than `limit`. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request body larger than ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

/** @param ctx - plugin context carrying the webServer service. */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  const basePath = String(config?.basePath ?? '/code-mode').replace(/\/+$/, '') || '/code-mode';
  const maxBodyBytes = Number.isFinite(config?.maxBodyBytes) ? config.maxBodyBytes : 65536;
  const token = randomBytes(16).toString('hex');
  const log = (level, message) => {
    try {
      ctx.logger?.(name)?.[level]?.(message);
    } catch {
      /* a logger is a nicety; the console works without one */
    }
  };

  const options = () => ({ cwd: process.cwd() });

  /** The four answers this row serves, each one a call into `ledger-admin.js`. */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://webserver');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === `${basePath}/ledgers`) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'use GET' });
      const inventory = inventoryOf(options());
      return send(res, 200, {
        token,
        basePath,
        files: LEDGER_FILES,
        groups: inventory.groups,
        ledgers: inventory.ledgers,
        trash: inventory.trash,
        store: inventory.store,
        machine: inventory.machine,
        cwd: inventory.cwd,
      });
    }

    if (pathname === `${basePath}/ledger`) {
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      const id = url.searchParams.get('id') ?? '';
      const file = url.searchParams.get('file') ?? 'mistakes.md';
      const read = readLedgerFile(id, file, options());
      return send(res, 200, read);
    }

    if (pathname === `${basePath}/action`) {
      if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
      if (req.headers['x-code-mode-token'] !== token) {
        return send(res, 403, { error: 'missing or stale token: reload the ledger list first' });
      }
      const raw = await readBody(req, maxBodyBytes);
      let body;
      try {
        body = JSON.parse(raw.length === 0 ? '{}' : raw);
      } catch {
        return send(res, 400, { error: 'body is not JSON' });
      }
      const action = String(body.action ?? '');
      const id = String(body.id ?? '');
      if (action === 'trash') return send(res, 200, trashLedger(id, { ...options(), session: '' }));
      if (action === 'restore') return send(res, 200, restoreTrash(id, options()));
      if (action === 'purge') return send(res, 200, purgeTrash(id, body.confirm, options()));
      return send(res, 400, { error: `unknown action ${JSON.stringify(action)}; use trash, restore or purge` });
    }

    return send(res, 404, { error: `no such route under ${basePath}` });
  }

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        log('warn', `refused ${req.method} ${req.url} from non-loopback ${String(req.socket?.remoteAddress)}`);
        return send(res, 403, { error: 'this console only answers loopback requests' });
      }
      const origin = req.headers?.origin;
      const site = req.headers?.['sec-fetch-site'];
      if (origin !== undefined) {
        let expected;
        try {
          expected = ctx.webServer.getOrigin();
        } catch {
          expected = undefined;
        }
        if (expected !== undefined && !sameOrigin(origin, expected)) {
          log('warn', `refused ${req.method} ${req.url} from origin ${String(origin)}`);
          return send(res, 403, { error: 'cross-origin request refused' });
        }
      }
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        return send(res, 403, { error: `cross-site request refused (Sec-Fetch-Site: ${site})` });
      }
      await route(req, res);
    } catch (error) {
      const message = String(error?.message ?? error);
      // A refusal this module made on purpose is the user's answer, not a server fault: the
      // page prints it verbatim. Anything else is a defect and says so.
      const deliberate = /refusing|may not|only answers|no ledger with id|no trashed ledger|already exists|is not there any more|cannot be written/i.test(message);
      if (!deliberate) log('warn', `ledger console failed: ${message}`);
      if (!res.headersSent) send(res, deliberate ? 409 : 500, { error: message });
      else res.end();
    }
  };

  const register = () => ctx.webServer.register({ kind: 'prefix', path: basePath, handler });
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => register(), 'code-ledger-admin: console routes');
  } else {
    register();
  }
  log('info', `ledger console serving ${basePath}/*`);
}

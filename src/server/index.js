import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { apiRouter } from './api.js';
import { autoStartConnectors } from './connector-control.js';
import { hubRouter } from './hub.js';
import { getValidWorkspaces } from '../utils/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Open a URL in the user's default browser as a fully-detached child process.
 *
 * We avoid the `open` npm package for the EADDRINUSE re-launch case because
 * its child can be killed mid-spawn when the parent calls process.exit very
 * shortly after — especially on Windows, where the spawn shells out to `cmd
 * /c start` and inherits stdio handles from the parent unless explicitly
 * detached. This helper uses platform-native commands with `detached: true`,
 * `stdio: 'ignore'`, and `unref()` so the child survives parent exit.
 */
function openBrowserDetached(url) {
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      // The empty "" after `start` is the title argument — required when the
      // URL is quoted, otherwise Windows interprets the URL as the title.
      cmd = 'cmd';
      args = ['/c', 'start', '""', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => { /* swallow — best-effort */ });
    child.unref();
  } catch {
    // Best-effort — if even spawn fails, we don't want to crash the CLI.
  }
}

export async function startServer(workspace, port, hubDir, openPath = '/') {
  const app = express();
  const isHub = !workspace;

  // Parse JSON/urlencoded for all routes except upload endpoints (which use raw body)
  const isUploadPath = (req) =>
    req.path.endsWith('/data/upload') || req.path.endsWith('/chat/upload') || req.path.includes('/hub/workspaces');

  app.use((req, res, next) => {
    if (isUploadPath(req)) return next();
    express.json({ limit: '5mb' })(req, res, next);
  });
  app.use((req, res, next) => {
    if (isUploadPath(req)) return next();
    express.urlencoded({ extended: true })(req, res, next);
  });

  // Always hub mode
  app.get('/api/mode', (req, res) => {
    res.json({ mode: 'hub' });
  });

  // Health / fingerprint endpoint. Used by `aaas dashboard` to detect when
  // a previous dashboard is already running on the target port — the CLI
  // probes here, and if it sees the AaaS signature it opens the browser
  // and exits cleanly instead of failing on EADDRINUSE.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'aaas-dashboard' });
  });

  // Hub API
  const hub = hubRouter(hubDir);
  app.use('/api/hub', hub);

  // Mount hub config/credentials/models at /api/ so the Settings page works in hub mode
  app.use('/api', hub);

  // Workspace API — route /api/ws/<name>/... to workspace-specific API routers
  const wsRouterCache = {};
  app.use('/api/ws', (req, res, next) => {
    // req.url is like '/Lyon/overview' or '/Lyon/skill'
    const match = req.url.match(/^\/([^/]+)(\/.*)?$/);
    if (!match) return res.status(400).json({ error: 'No workspace specified' });

    const wsName = match[1];
    const remainingPath = match[2] || '/';

    // Try local hub subdirectory first, then check global registry
    let wsPath = path.join(hubDir, wsName);
    let skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');

    if (!fs.existsSync(skillPath)) {
      const registered = getValidWorkspaces().find(w => path.basename(w.path) === wsName);
      if (registered) {
        wsPath = registered.path;
        skillPath = path.join(wsPath, 'skills', 'aaas', 'SKILL.md');
      }
    }

    if (!fs.existsSync(skillPath)) {
      return res.status(404).json({ error: `Workspace "${wsName}" not found` });
    }

    // Create and cache the router for this workspace
    if (!wsRouterCache[wsName]) {
      wsRouterCache[wsName] = apiRouter(wsPath);
    }

    // Rewrite req.url so the workspace router sees just the remaining path
    const originalUrl = req.url;
    req.url = remainingPath;
    wsRouterCache[wsName](req, res, (err) => {
      req.url = originalUrl; // restore on fallthrough
      next(err);
    });
  });

  // Serve dashboard static files
  const dashboardDist = path.join(__dirname, '..', '..', 'dashboard', 'dist');
  app.use(express.static(dashboardDist));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });

  const url = `http://localhost:${port}`;
  const openUrl = openPath !== '/' ? `${url}${openPath}` : url;

  // Bring up any connectors flagged to start with the dashboard. Per-workspace,
  // per-connector, opt-in; skips anything already running or owned by a daemon.
  // Best-effort and fully isolated so it can never delay or fail server boot.
  async function autoStartAll() {
    let workspaces;
    try { workspaces = getValidWorkspaces(); } catch { return; }
    for (const w of workspaces) {
      try {
        const results = await autoStartConnectors(w.path);
        for (const r of results) {
          if (r.ok && !r.skipped) {
            console.log(chalk.green(`  Auto-started ${r.platform} for ${path.basename(w.path)}`));
          } else if (r.error) {
            console.log(chalk.yellow(`  Auto-start ${r.platform} (${path.basename(w.path)}) failed: ${r.error}`));
          }
        }
      } catch (e) {
        console.log(chalk.yellow(`  Auto-start skipped for ${path.basename(w.path)}: ${e.message}`));
      }
    }
  }

  const server = app.listen(port, () => {
    console.log(chalk.green(`  Dashboard running at ${chalk.bold(url)}\n`));
    openBrowserDetached(openUrl);
    autoStartAll();
  });

  // If the port is already taken, check whether it's our own dashboard. If
  // so, just open the browser to the running instance and exit cleanly —
  // this is the normal case when a user clicks the desktop shortcut twice.
  // If it's some other process, surface a clear error instead of crashing.
  server.on('error', async (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const running = await isOurDashboardRunning(port);
      if (running) {
        console.log(chalk.green(`  Dashboard already running at ${chalk.bold(url)} — opening browser.\n`));
        openBrowserDetached(openUrl);
        // Give the spawned child a beat to fully detach before we exit.
        // openBrowserDetached uses detached + ignored stdio + unref(), so the
        // child should survive parent exit on its own — the small delay is
        // belt-and-suspenders for slow systems where the OS scheduler hasn't
        // run the child's first instruction yet.
        await new Promise(r => setTimeout(r, 300));
        process.exit(0);
      }
      console.error(chalk.red(`\n  Port ${port} is in use by another process.`));
      console.error(chalk.gray(`  Either stop that process or pass a different port: aaas dashboard --port <N>\n`));
      process.exit(1);
    }
    throw err;
  });
}

/**
 * Probe a localhost port to see if an AaaS dashboard is running there.
 *
 * Tries the dedicated `/api/health` fingerprint first (added when EADDRINUSE
 * handling was introduced). Falls back to `/api/mode` returning the AaaS
 * `{ mode: 'hub' }` shape — this matters for users whose existing dashboard
 * was started before `/api/health` shipped: without the fallback, the new
 * CLI would treat them as a foreign process and refuse to open the browser.
 *
 * Both probes time out fast (1.5s) so a hung process on the port doesn't
 * stall the CLI.
 */
async function isOurDashboardRunning(port) {
  const base = `http://localhost:${port}`;

  const probe = async (path, predicate) => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${base}${path}`, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return false;
      const body = await res.json();
      return predicate(body);
    } catch {
      return false;
    }
  };

  // 1) New endpoint, exact signature.
  if (await probe('/api/health', b => b && b.service === 'aaas-dashboard')) return true;
  // 2) Fallback for dashboards that predate /api/health.
  if (await probe('/api/mode', b => b && b.mode === 'hub')) return true;
  return false;
}

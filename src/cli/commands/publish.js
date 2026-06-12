import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { findWorkspace } from '../../utils/workspace.js';
import { getValidWorkspaces } from '../../utils/registry.js';
import { exportWorkspace, slugify } from '../../export/index.js';

/**
 * aaas publish [agent-name] --business "<name>"
 *
 * Exports a workspace and uploads it to StreetAI, returning a customer-facing
 * setup link. The operator sends that one link to the client, who opens it,
 * downloads StreetAI-Setup.bat, and runs it.
 *
 * Auth: needs the server admin key. Provide via --key or $STREETAI_PUBLISH_KEY.
 * Server defaults to https://streetai.org (override with --server or
 * $STREETAI_PUBLISH_URL).
 */
export async function publishCommand(agentName, options = {}) {
  if (agentName && typeof agentName === 'object' && !options) {
    options = agentName; agentName = undefined;
  }

  const ws = resolveWorkspace(agentName);
  const server = (options.server || process.env.STREETAI_PUBLISH_URL || 'https://streetai.org').replace(/\/$/, '');
  const key = options.key || process.env.STREETAI_PUBLISH_KEY;
  const noSecrets = options.secrets === false;

  if (!key) {
    console.error(chalk.red('\n  Error: no admin key.\n'));
    console.log(chalk.gray('  Set it once:'));
    console.log(chalk.gray('    PowerShell:  $env:STREETAI_PUBLISH_KEY = "<your-admin-key>"'));
    console.log(chalk.gray('  or pass --key <your-admin-key>\n'));
    process.exit(1);
  }

  // Convert the agent photo to an .ico now (at publish), so the installer can
  // use it for the desktop shortcut without converting on the client machine.
  try {
    const png = path.join(ws, '.aaas', 'avatar.png');
    if (fs.existsSync(png)) {
      fs.writeFileSync(path.join(ws, '.aaas', 'avatar.ico'), pngToIco(fs.readFileSync(png)));
    }
  } catch (err) {
    console.log(chalk.gray(`  (icon skipped: ${err.message})`));
  }

  // 1. Export to a temp bundle.
  console.log('');
  console.log(chalk.bold('Publishing workspace') + chalk.gray(` (${path.basename(ws)})`));
  const tmp = path.join(os.tmpdir(), `streetai-publish-${Date.now()}.tar.gz`);
  let result;
  try {
    result = await exportWorkspace(ws, { noSecrets, outputPath: tmp });
  } catch (err) {
    console.error(chalk.red(`\n  Export failed: ${err.message}\n`));
    process.exit(1);
  }

  const slug = slugify(result.manifest.workspace_name || path.basename(ws));
  const business = options.business || result.manifest.workspace_name || slug;

  // 2. Upload to the server.
  console.log(chalk.gray(`  Uploading to ${server} ...`));
  let data;
  try {
    const bytes = fs.readFileSync(result.outputPath);
    const resp = await fetch(`${server}/admin/bundle`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/gzip',
        'X-Business': encodeURIComponent(business),
        'X-Slug': slug,
      },
      body: bytes,
    });
    data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `Server returned ${resp.status}`);
    }
  } catch (err) {
    console.error(chalk.red(`\n  Upload failed: ${err.message}\n`));
    process.exit(1);
  } finally {
    try { fs.unlinkSync(result.outputPath); } catch { /* ignore */ }
  }

  // 3. Show the link to send the client.
  console.log(chalk.green('\n  Published.\n'));
  console.log(chalk.bold('  Send this link to the client:'));
  console.log('    ' + chalk.cyan(data.setupUrl));
  console.log('');
  console.log(chalk.gray('  New client → installs. Existing client → updates in place'));
  console.log(chalk.gray('  (keeps their sessions, data, and credentials). Same link either way.'));
  console.log('');
  console.log(chalk.gray(`  Business: ${business}`));
  console.log(chalk.gray(`  Expires:  ${new Date(data.expiresAt).toLocaleString()}`));
  if (!noSecrets) {
    console.log(chalk.yellow('\n  Note: this bundle includes credentials. Only send the link to this client.'));
  }
  console.log('');
}

/**
 * Wrap a PNG into a minimal .ico (Vista+ supports PNG-compressed icons), so no
 * image library is needed. Reads width/height from the PNG IHDR header.
 */
function pngToIco(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);   // reserved
  dir.writeUInt16LE(1, 2);   // type: icon
  dir.writeUInt16LE(1, 4);   // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w >= 256 ? 0 : w, 0);   // width  (0 means 256+)
  entry.writeUInt8(h >= 256 ? 0 : h, 1);   // height (0 means 256+)
  entry.writeUInt8(0, 2);    // palette colors
  entry.writeUInt8(0, 3);    // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image data size
  entry.writeUInt32LE(22, 12);         // offset (6 + 16)
  return Buffer.concat([dir, entry, png]);
}

/** Resolve a workspace by name (registry) or fall back to the CWD's workspace. */
function resolveWorkspace(agentName) {
  const workspaces = getValidWorkspaces();
  if (agentName) {
    const match = workspaces.find(w =>
      path.basename(w.path) === agentName ||
      w.name?.toLowerCase() === agentName.toLowerCase());
    if (match) return match.path;
    console.error(chalk.red(`\n  Error: Agent "${agentName}" not found in registry.\n`));
    if (workspaces.length > 0) {
      console.log(chalk.gray('  Registered agents:'));
      for (const w of workspaces) console.log(chalk.gray(`    - ${w.name} (${path.basename(w.path)})`));
    }
    console.log('');
    process.exit(1);
  }
  const ws = findWorkspace();
  if (ws) return ws;
  console.error(chalk.red('\n  Error: No workspace found here. Pass an agent name or cd into a workspace.\n'));
  process.exit(1);
}

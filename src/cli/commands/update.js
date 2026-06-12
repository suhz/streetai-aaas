import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { readManifest, applyUpdate } from '../../export/index.js';
import { findWorkspace, formatBytes } from '../../utils/workspace.js';
import { getValidWorkspaces } from '../../utils/registry.js';

/**
 * aaas update <source> [--name <agent>] [--workspace <dir>] [--dry-run] [--no-backup]
 *
 * Non-destructively update an ALREADY-INSTALLED workspace from a published
 * bundle. Unlike `aaas import` (which creates/overwrites a workspace), this
 * preserves the client's runtime state — sessions, data, memory, credentials,
 * connections, and transactions — and only applies the publisher's definition
 * (skills, extensions, data-source config, new assets).
 *
 * `source` may be a URL (downloaded the same way the installer fetches bundles)
 * or a local .tar.gz. The target workspace is resolved from --workspace, then
 * --name (registry), then the bundle's own workspace_name, then the CWD.
 */
export async function updateCommand(source, options = {}) {
  // 1. Resolve the bundle: URL → download to a temp file; else a local path.
  let archivePath;
  let tmpFile = null;
  if (/^https?:\/\//i.test(source)) {
    tmpFile = path.join(os.tmpdir(), `aaas-update-${Date.now()}.tgz`);
    console.log(chalk.gray(`  Downloading bundle …`));
    try {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      fs.writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
      archivePath = tmpFile;
    } catch (err) {
      console.error(chalk.red(`✗ ${err.message}`));
      cleanup(tmpFile);
      process.exit(1);
    }
  } else {
    archivePath = path.resolve(source);
    if (!fs.existsSync(archivePath)) {
      console.error(chalk.red(`✗ Archive not found: ${archivePath}`));
      process.exit(1);
    }
  }

  // 2. Read the manifest (also validates the bundle / version).
  let manifest;
  try { manifest = await readManifest(archivePath); }
  catch (err) { console.error(chalk.red(`✗ ${err.message}`)); cleanup(tmpFile); process.exit(1); }

  // 3. Resolve the existing target workspace.
  const target = resolveTarget(options, manifest);
  if (!target) {
    console.error(chalk.red('✗ Could not find the workspace to update.'));
    console.log(chalk.gray('  Pass --name <agent>, or --workspace <dir>, or run inside the workspace.'));
    cleanup(tmpFile);
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold('Updating workspace'));
  console.log(`  Target:   ${target}`);
  console.log(`  Bundle:   ${chalk.cyan(manifest.workspace_name)} · aaas ${manifest.aaas_version} · created ${manifest.created_at} ${chalk.gray(`(${formatBytes(fs.statSync(archivePath).size)})`)}`);
  if (options.dryRun) console.log(chalk.yellow('  Mode:     dry-run — nothing will be written'));
  console.log('');

  // 4. Apply.
  let result;
  try {
    result = await applyUpdate(archivePath, target, {
      backup: options.backup !== false,
      dryRun: !!options.dryRun,
    });
  } catch (err) {
    console.error(chalk.red(`✗ ${err.message}`));
    cleanup(tmpFile);
    process.exit(1);
  } finally {
    cleanup(tmpFile);
  }

  // 5. Report.
  const tag = options.dryRun ? chalk.yellow('[dry-run] ') : '';
  console.log(chalk.green(`✓ ${tag}Update applied.`));
  if (result.updated.length) console.log(`  Updated:   ${result.updated.length} definition file(s) (skills, extensions, config, …)`);
  if (result.merged.length) console.log(`  Merged:    ${result.merged.join(', ')} ${chalk.gray('(kept your settings/keys)')}`);
  if (result.added.length) console.log(`  Added:     ${result.added.length} new file(s) (assets/data the client didn't have)`);
  console.log(chalk.gray('  Preserved: sessions, data, memory, credentials, connections, transactions'));
  if (result.backupDir) console.log(chalk.gray(`  Backup:    ${result.backupDir}`));

  // New extensions whose API keys were stripped from the bundle → flag them.
  const needKeys = (manifest.requires || [])
    .filter((r) => r.kind === 'extension_api_key' && (result.newExtensions || []).includes(r.name))
    .map((r) => r.name);
  if (needKeys.length) {
    console.log(chalk.yellow(`\n  New extension(s) need an API key: ${needKeys.join(', ')}`));
    console.log(chalk.gray('  Set them in the dashboard → Extensions.'));
  }

  if (!options.dryRun) console.log(chalk.gray('\n  Restart the agent (or dashboard) to load the changes.\n'));
}

/** Resolve the workspace to update: --workspace, then --name (registry), then
 *  the bundle's workspace_name (registry), then the current directory. */
function resolveTarget(options, manifest) {
  if (options.workspace) {
    const p = path.resolve(options.workspace);
    return fs.existsSync(p) ? p : null;
  }
  const name = options.name || manifest.workspace_name;
  if (name) {
    const match = getValidWorkspaces().find(
      (w) => path.basename(w.path) === name || w.name?.toLowerCase() === String(name).toLowerCase(),
    );
    if (match) return match.path;
  }
  return findWorkspace() || null;
}

function cleanup(file) {
  if (file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
}

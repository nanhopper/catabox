import { cp, mkdir, readdir, rm, stat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GENERATED_PATHS, isMainModule } from './constants.mjs';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function copyStatusToDocs({
  statusPath = GENERATED_PATHS.status,
  docsStatusPath = GENERATED_PATHS.docsStatus
} = {}) {
  if (!(await exists(statusPath))) {
    return;
  }
  await mkdir(GENERATED_PATHS.docsDataDir, { recursive: true });
  await copyFile(statusPath, docsStatusPath);
}

async function copySnapshots({
  snapshotsDir = GENERATED_PATHS.snapshotsDir,
  docsSnapshotsDir = GENERATED_PATHS.docsSnapshotsDir
} = {}) {
  await rm(docsSnapshotsDir, { recursive: true, force: true });
  await mkdir(docsSnapshotsDir, { recursive: true });
  if (!(await exists(snapshotsDir))) {
    return;
  }
  const entries = await readdir(snapshotsDir);
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    await cp(join(snapshotsDir, entry), join(docsSnapshotsDir, entry));
  }
}

export async function renderSite({
  templatePath = GENERATED_PATHS.template,
  docsIndexPath = GENERATED_PATHS.docsIndex,
  dataDir = GENERATED_PATHS.dataDir,
  docsDataDir = GENERATED_PATHS.docsDataDir
} = {}) {
  await mkdir(docsDataDir, { recursive: true });
  await copyFile(templatePath, docsIndexPath);
  for (const fileName of ['current.json', 'history.json', 'status.json']) {
    await copyFile(join(dataDir, fileName), join(docsDataDir, fileName));
  }
  await copySnapshots();
}

if (isMainModule(import.meta.url)) {
  renderSite().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

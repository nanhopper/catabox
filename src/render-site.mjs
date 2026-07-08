import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GENERATED_PATHS, isMainModule } from './constants.mjs';

export async function renderSite({
  templatePath = GENERATED_PATHS.template,
  siteIndexPath = GENERATED_PATHS.siteIndex
} = {}) {
  await mkdir(dirname(siteIndexPath), { recursive: true });
  await copyFile(templatePath, siteIndexPath);
}

if (isMainModule(import.meta.url)) {
  renderSite().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

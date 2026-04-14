/**
 * ============================================================================
 * PATH RESOLUTION — Works from both source (tsx) and dist (node)
 * ============================================================================
 *
 * Problem: __dirname resolves differently in dev vs production:
 *   - Dev (tsx):  /path/to/qa-system/src/engine/
 *   - Prod (node): /usr/lib/node_modules/qa-system/dist/src/engine/
 *
 * Solution: Framework assets (prompts, rules, agents) resolve from the
 * package root. Project data (reports, experience-db) resolves from CWD.
 * ============================================================================
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Find the framework package root by walking up from __dirname
 * looking for package.json with name "qa-system".
 */
function findFrameworkRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'qa-system') return dir;
      } catch { /* skip */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume 2 levels up from engine/ (works in both src/ and dist/src/)
  return path.resolve(__dirname, '..', '..');
}

/** Framework package root (where package.json, src/rules, src/prompts live) */
export const FRAMEWORK_ROOT = findFrameworkRoot();

/** Path to framework assets (rules, prompts, agents, presets) */
export function frameworkAsset(...segments: string[]): string {
  return path.join(FRAMEWORK_ROOT, ...segments);
}

/**
 * Path to project-local qa-system directory.
 * In production: relative to CWD (the target project).
 * Falls back to qa-system/ in CWD.
 */
export function projectQaDir(projectRoot?: string): string {
  return path.resolve(projectRoot || process.cwd(), 'qa-system');
}

/** Path to project-local reports */
export function projectReportsDir(projectRoot?: string): string {
  return path.join(projectQaDir(projectRoot), 'reports');
}

/** Path to project-local data files (experience-db, learning-db, etc.) */
export function projectDataFile(filename: string, projectRoot?: string): string {
  return path.join(projectQaDir(projectRoot), filename);
}

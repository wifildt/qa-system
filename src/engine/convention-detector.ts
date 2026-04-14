/**
 * ============================================================================
 * CONVENTION DETECTOR — Auto-detects repo patterns and generates project config
 * ============================================================================
 *
 * Drop any frontend repo → this agent scans it → produces project.config.json
 *
 * Detects:
 *   - Framework (React/Next/Vue/Angular/Svelte)
 *   - State management (Redux/Zustand/Pinia/MobX/etc.)
 *   - API client (axios/fetch/apisauce/ky)
 *   - Routing (react-router/next/vue-router)
 *   - UI library (antd/mui/chakra/shadcn)
 *   - Styling (styled-components/tailwind/css-modules)
 *   - Form library (react-hook-form/formik/antd-form)
 *   - Test runner (vitest/jest/cypress/playwright)
 *   - File naming conventions
 *   - i18n usage
 *
 * Usage:
 *   npx tsx qa-system/core/engine/convention-detector.ts /path/to/repo
 *   npx tsx qa-system/core/engine/convention-detector.ts .  (current dir)
 *
 * Output:
 *   qa-system/projects/{repo-name}.config.json
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// TYPES
// ============================================================================

interface DetectionResult {
  detected: string;
  confidence: number; // 0-1
  evidence: string;   // what file/pattern confirmed this
}

interface DetectedConfig {
  project: {
    name: string;
    root: string;
    src_dir: string;
    language: string;
    package_manager: string;
  };
  framework: { name: string; version?: string; bundler: string; ui_library: string; styling: string };
  state: { manager: string; side_effects: string; store_path: string };
  routing: { type: string; route_files: string[] };
  api: { client: string; interceptor_file: string; response_format: any };
  selectors: { priority: string[]; testid_attribute: string; forbidden_patterns: string[] };
  test_runner: { unit: string; e2e: string };
  conventions: { file_naming: string; component_pattern: string; api_pattern: string; form_library: string; i18n: boolean };
  _detection_log: Array<{ category: string; result: DetectionResult }>;
}

// ============================================================================
// FILE HELPERS
// ============================================================================

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function globFiles(dir: string, ext: string[], maxDepth: number = 4): string[] {
  const results: string[] = [];
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (ext.some(e => entry.name.endsWith(e))) {
          results.push(full);
        }
      }
    } catch { /* permission errors */ }
  }
  walk(dir, 0);
  return results;
}

function countPattern(files: string[], pattern: RegExp): number {
  let count = 0;
  for (const file of files.slice(0, 50)) { // Sample first 50 files
    const content = readFileIfExists(file);
    if (content && pattern.test(content)) count++;
  }
  return count;
}

// ============================================================================
// DETECTORS — Each returns a DetectionResult
// ============================================================================

function detectPackageManager(root: string): DetectionResult {
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return { detected: 'bun', confidence: 1, evidence: 'bun.lockb' };
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return { detected: 'pnpm', confidence: 1, evidence: 'pnpm-lock.yaml' };
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return { detected: 'yarn', confidence: 1, evidence: 'yarn.lock' };
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return { detected: 'npm', confidence: 1, evidence: 'package-lock.json' };
  return { detected: 'npm', confidence: 0.5, evidence: 'default (no lockfile found)' };
}

function detectFramework(pkg: any): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['next']) return { detected: 'nextjs', confidence: 0.95, evidence: `next@${deps['next']}` };
  if (deps['nuxt'] || deps['nuxt3']) return { detected: 'nuxt', confidence: 0.95, evidence: 'nuxt in deps' };
  if (deps['vue']) return { detected: 'vue', confidence: 0.9, evidence: `vue@${deps['vue']}` };
  if (deps['@angular/core']) return { detected: 'angular', confidence: 0.95, evidence: '@angular/core' };
  if (deps['svelte']) return { detected: 'svelte', confidence: 0.9, evidence: 'svelte' };
  if (deps['react']) return { detected: 'react', confidence: 0.9, evidence: `react@${deps['react']}` };
  return { detected: 'react', confidence: 0.3, evidence: 'default fallback' };
}

function detectBundler(pkg: any, root: string): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['vite'] || fs.existsSync(path.join(root, 'vite.config.ts')) || fs.existsSync(path.join(root, 'vite.config.js')))
    return { detected: 'vite', confidence: 0.95, evidence: 'vite config or dependency' };
  if (deps['turbopack'] || deps['next']) return { detected: 'turbopack', confidence: 0.6, evidence: 'nextjs (may use turbo)' };
  if (fs.existsSync(path.join(root, 'webpack.config.js')) || deps['webpack'])
    return { detected: 'webpack', confidence: 0.9, evidence: 'webpack config or dependency' };
  return { detected: 'vite', confidence: 0.3, evidence: 'default' };
}

function detectUILibrary(pkg: any): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['antd']) return { detected: 'antd', confidence: 0.95, evidence: `antd@${deps['antd']}` };
  if (deps['@mui/material'] || deps['@material-ui/core']) return { detected: 'mui', confidence: 0.95, evidence: 'MUI' };
  if (deps['@chakra-ui/react']) return { detected: 'chakra', confidence: 0.95, evidence: 'chakra-ui' };
  if (deps['@radix-ui/react-dialog'] || deps['class-variance-authority']) return { detected: 'shadcn', confidence: 0.7, evidence: 'radix + cva' };
  return { detected: 'none', confidence: 0.5, evidence: 'no major UI library found' };
}

function detectStyling(pkg: any, srcDir: string): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const results: Array<{ name: string; score: number }> = [];

  if (deps['styled-components']) results.push({ name: 'styled-components', score: 3 });
  if (deps['tailwindcss']) results.push({ name: 'tailwind', score: 3 });
  if (deps['@emotion/react'] || deps['@emotion/styled']) results.push({ name: 'emotion', score: 3 });
  if (deps['sass'] || deps['node-sass']) results.push({ name: 'sass', score: 2 });

  // Check for CSS modules
  const cssModules = globFiles(srcDir, ['.module.css', '.module.scss'], 2);
  if (cssModules.length > 5) results.push({ name: 'css-modules', score: 2 });

  if (results.length === 0) return { detected: 'mixed', confidence: 0.3, evidence: 'no styling library detected' };
  if (results.length > 1) return { detected: 'mixed', confidence: 0.7, evidence: results.map(r => r.name).join(' + ') };
  return { detected: results[0].name, confidence: 0.85, evidence: results[0].name };
}

function detectStateManager(pkg: any, srcDir: string): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (deps['@reduxjs/toolkit'] || deps['redux']) {
    const sideEffect = deps['redux-saga'] ? 'redux-saga'
      : deps['redux-thunk'] ? 'redux-thunk'
      : deps['@reduxjs/toolkit'] ? 'rtk-query'
      : 'none';

    return { detected: deps['@reduxjs/toolkit'] ? 'redux-toolkit' : 'redux', confidence: 0.95, evidence: `redux + ${sideEffect}` };
  }
  if (deps['zustand']) return { detected: 'zustand', confidence: 0.95, evidence: 'zustand' };
  if (deps['mobx']) return { detected: 'mobx', confidence: 0.95, evidence: 'mobx' };
  if (deps['pinia']) return { detected: 'pinia', confidence: 0.95, evidence: 'pinia' };
  if (deps['vuex']) return { detected: 'vuex', confidence: 0.9, evidence: 'vuex' };
  if (deps['jotai']) return { detected: 'jotai', confidence: 0.9, evidence: 'jotai' };
  if (deps['recoil']) return { detected: 'recoil', confidence: 0.9, evidence: 'recoil' };

  return { detected: 'context-only', confidence: 0.5, evidence: 'no state library in deps' };
}

function detectSideEffects(pkg: any): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['redux-saga']) return { detected: 'redux-saga', confidence: 0.95, evidence: 'redux-saga' };
  if (deps['@tanstack/react-query']) return { detected: 'tanstack-query', confidence: 0.9, evidence: '@tanstack/react-query' };
  if (deps['swr']) return { detected: 'swr', confidence: 0.9, evidence: 'swr' };
  if (deps['redux-thunk']) return { detected: 'redux-thunk', confidence: 0.8, evidence: 'redux-thunk' };
  return { detected: 'none', confidence: 0.5, evidence: 'no side effect library' };
}

function detectRouting(pkg: any, framework: string): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (framework === 'nextjs') return { detected: 'nextjs-app', confidence: 0.8, evidence: 'next.js framework' };
  if (deps['react-router-dom'] || deps['react-router']) return { detected: 'react-router', confidence: 0.95, evidence: 'react-router-dom' };
  if (deps['vue-router']) return { detected: 'vue-router', confidence: 0.95, evidence: 'vue-router' };
  if (deps['@tanstack/react-router']) return { detected: 'tanstack-router', confidence: 0.9, evidence: '@tanstack/react-router' };
  return { detected: 'custom', confidence: 0.3, evidence: 'no router library found' };
}

function detectAPIClient(pkg: any): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['apisauce']) return { detected: 'apisauce', confidence: 0.95, evidence: 'apisauce' };
  if (deps['axios']) return { detected: 'axios', confidence: 0.9, evidence: 'axios' };
  if (deps['ky']) return { detected: 'ky', confidence: 0.9, evidence: 'ky' };
  return { detected: 'fetch', confidence: 0.5, evidence: 'default (native fetch)' };
}

function detectTestRunner(pkg: any): { unit: DetectionResult; e2e: DetectionResult } {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};
  const scriptStr = JSON.stringify(scripts);

  const unit: DetectionResult = deps['vitest'] || scriptStr.includes('vitest')
    ? { detected: 'vitest', confidence: 0.95, evidence: 'vitest' }
    : deps['jest'] ? { detected: 'jest', confidence: 0.9, evidence: 'jest' }
    : { detected: 'vitest', confidence: 0.3, evidence: 'default' };

  const e2e: DetectionResult = deps['playwright'] || deps['@playwright/test']
    ? { detected: 'playwright', confidence: 0.95, evidence: 'playwright' }
    : deps['cypress'] ? { detected: 'cypress', confidence: 0.95, evidence: 'cypress' }
    : { detected: 'playwright', confidence: 0.3, evidence: 'default' };

  return { unit, e2e };
}

function detectFormLibrary(pkg: any): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['react-hook-form']) return { detected: 'react-hook-form', confidence: 0.95, evidence: 'react-hook-form' };
  if (deps['formik']) return { detected: 'formik', confidence: 0.95, evidence: 'formik' };
  return { detected: 'native', confidence: 0.5, evidence: 'no form library' };
}

function detectLanguage(srcDir: string): DetectionResult {
  const tsFiles = globFiles(srcDir, ['.ts', '.tsx'], 2).length;
  const jsFiles = globFiles(srcDir, ['.js', '.jsx'], 2).length;
  const total = tsFiles + jsFiles;
  if (total === 0) return { detected: 'mixed', confidence: 0.3, evidence: 'no source files found' };
  const tsRatio = tsFiles / total;
  if (tsRatio > 0.8) return { detected: 'typescript', confidence: 0.9, evidence: `${(tsRatio * 100).toFixed(0)}% TS files` };
  if (tsRatio < 0.2) return { detected: 'javascript', confidence: 0.9, evidence: `${((1 - tsRatio) * 100).toFixed(0)}% JS files` };
  return { detected: 'mixed', confidence: 0.8, evidence: `${(tsRatio * 100).toFixed(0)}% TS, ${((1 - tsRatio) * 100).toFixed(0)}% JS` };
}

function detectSrcDir(root: string): string {
  const candidates = ['src', 'app', 'lib', 'source', 'client'];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(root, dir)) && fs.statSync(path.join(root, dir)).isDirectory()) {
      return dir;
    }
  }
  return 'src';
}

function detectStoreDir(srcDir: string, stateManager: string): string {
  const candidates = ['store', 'store/modules', 'stores', 'state', 'redux', 'slices'];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(srcDir, dir))) return dir;
  }
  return 'store';
}

function detectFileNaming(srcDir: string): DetectionResult {
  const files = globFiles(srcDir, ['.jsx', '.tsx', '.vue'], 2).map(f => path.basename(f, path.extname(f)));
  if (files.length === 0) return { detected: 'mixed', confidence: 0.3, evidence: 'no component files' };

  let pascal = 0, camel = 0, kebab = 0, snake = 0;
  for (const name of files.slice(0, 30)) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascal++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) camel++;
    else if (/^[a-z][a-z0-9-]*$/.test(name)) kebab++;
    else if (/^[a-z][a-z0-9_]*$/.test(name)) snake++;
  }

  const max = Math.max(pascal, camel, kebab, snake);
  if (max === pascal) return { detected: 'PascalCase', confidence: pascal / files.length, evidence: `${pascal}/${files.length} PascalCase` };
  if (max === camel) return { detected: 'camelCase', confidence: camel / files.length, evidence: `${camel}/${files.length} camelCase` };
  if (max === kebab) return { detected: 'kebab-case', confidence: kebab / files.length, evidence: `${kebab}/${files.length} kebab-case` };
  return { detected: 'mixed', confidence: 0.5, evidence: 'mixed naming' };
}

function detectI18n(pkg: any): DetectionResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['react-i18next'] || deps['i18next']) return { detected: 'react-i18next', confidence: 0.95, evidence: 'react-i18next' };
  if (deps['vue-i18n']) return { detected: 'vue-i18n', confidence: 0.95, evidence: 'vue-i18n' };
  if (deps['next-intl']) return { detected: 'next-intl', confidence: 0.95, evidence: 'next-intl' };
  return { detected: 'none', confidence: 0.7, evidence: 'no i18n library' };
}

function detectForbiddenSelectors(uiLib: string): string[] {
  const base = [':nth-child(', '[class*='];
  switch (uiLib) {
    case 'antd': return [...base, '.ant-*', '.sc-*', '.css-*'];
    case 'mui': return [...base, '.Mui*', '.css-*'];
    case 'chakra': return [...base, '.chakra-*', '.css-*'];
    default: return [...base, '.css-*'];
  }
}

// ============================================================================
// MAIN DETECTOR
// ============================================================================

function detectConventions(repoRoot: string): DetectedConfig {
  const log: Array<{ category: string; result: DetectionResult }> = [];
  function record(category: string, result: DetectionResult): DetectionResult {
    log.push({ category, result });
    return result;
  }

  // Read package.json
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkgContent = readFileIfExists(pkgPath);
  if (!pkgContent) {
    throw new Error(`No package.json found at ${pkgPath}. Is this a frontend repo?`);
  }
  const pkg = JSON.parse(pkgContent);

  const srcDir = detectSrcDir(repoRoot);
  const fullSrcDir = path.join(repoRoot, srcDir);

  // Run all detectors
  const framework = record('framework', detectFramework(pkg));
  const bundler = record('bundler', detectBundler(pkg, repoRoot));
  const uiLib = record('ui_library', detectUILibrary(pkg));
  const styling = record('styling', detectStyling(pkg, fullSrcDir));
  const state = record('state', detectStateManager(pkg, fullSrcDir));
  const sideEffects = record('side_effects', detectSideEffects(pkg));
  const routing = record('routing', detectRouting(pkg, framework.detected));
  const apiClient = record('api_client', detectAPIClient(pkg));
  const testRunners = detectTestRunner(pkg);
  record('test_unit', testRunners.unit);
  record('test_e2e', testRunners.e2e);
  const formLib = record('form_library', detectFormLibrary(pkg));
  const language = record('language', detectLanguage(fullSrcDir));
  const fileNaming = record('file_naming', detectFileNaming(fullSrcDir));
  const i18n = record('i18n', detectI18n(pkg));
  const pkgManager = record('package_manager', detectPackageManager(repoRoot));
  const storeDir = detectStoreDir(fullSrcDir, state.detected);

  return {
    project: {
      name: pkg.name || path.basename(repoRoot),
      root: repoRoot,
      src_dir: srcDir,
      language: language.detected,
      package_manager: pkgManager.detected,
    },
    framework: {
      name: framework.detected,
      version: pkg.dependencies?.[framework.detected] || pkg.dependencies?.react || undefined,
      bundler: bundler.detected,
      ui_library: uiLib.detected,
      styling: styling.detected,
    },
    state: {
      manager: state.detected,
      side_effects: sideEffects.detected,
      store_path: storeDir,
    },
    routing: {
      type: routing.detected,
      route_files: [], // AI agent fills these by scanning
    },
    api: {
      client: apiClient.detected,
      interceptor_file: '',
      response_format: { data_key: 'data', error_key: 'errors' },
    },
    selectors: {
      priority: ['data-testid', 'aria-label', 'role', 'text'],
      testid_attribute: 'data-testid',
      forbidden_patterns: detectForbiddenSelectors(uiLib.detected),
    },
    test_runner: {
      unit: testRunners.unit.detected,
      e2e: testRunners.e2e.detected,
    },
    conventions: {
      file_naming: fileNaming.detected,
      component_pattern: 'function',
      api_pattern: state.detected.includes('redux') ? 'functional' : 'mixed',
      form_library: formLib.detected,
      i18n: i18n.detected !== 'none',
    },
    _detection_log: log,
  };
}

// ============================================================================
// CLI
// ============================================================================

function main(): void {
  const repoRoot = process.argv[2] || '.';
  const absRoot = path.resolve(repoRoot);

  console.log(`\nConvention Detector — Scanning: ${absRoot}\n`);

  if (!fs.existsSync(path.join(absRoot, 'package.json'))) {
    console.error('ERROR: No package.json found. Provide a frontend repo path.');
    process.exit(1);
  }

  const config = detectConventions(absRoot);

  // Print detection log
  console.log('Detection Results:');
  console.log('─'.repeat(60));
  for (const entry of config._detection_log) {
    const conf = (entry.result.confidence * 100).toFixed(0);
    const icon = entry.result.confidence >= 0.8 ? '✓' : entry.result.confidence >= 0.5 ? '~' : '?';
    console.log(`  ${icon} ${entry.category.padEnd(20)} ${entry.result.detected.padEnd(20)} ${conf}%  (${entry.result.evidence})`);
  }
  console.log('─'.repeat(60));

  // Write config (without _detection_log)
  const { _detection_log, ...cleanConfig } = config;
  const outputDir = path.resolve(process.cwd(), 'qa-system');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${config.project.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}.config.json`);
  fs.writeFileSync(outputPath, JSON.stringify(cleanConfig, null, 2));

  console.log(`\nConfig written to: ${outputPath}`);
  console.log('\nNext steps:');
  console.log('  1. Review and fill in missing fields (auth accounts, features, entry URLs)');
  console.log('  2. Run: npx tsx qa-system/core/engine/orchestrator.ts --config ' + outputPath);
}

export { detectConventions };
export type { DetectedConfig };

if (process.argv[1]?.includes('convention-detector')) {
  main();
}

/**
 * PROJECT ADAPTER - Normalizes any repo into standard agent input.
 * Reads project.config.json and exposes a unified API for all agents.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================

interface ProjectConfig {
  project: {
    name: string;
    root: string;
    src_dir: string;
    language: string;
    package_manager: string;
  };
  framework: {
    name: string;
    version?: string;
    bundler: string;
    ui_library: string;
    styling: string;
  };
  state: {
    manager: string;
    side_effects: string;
    store_path: string;
    expose_on_window?: boolean;
    expose_key?: string;
  };
  routing: {
    type: string;
    route_files: string[];
    base_path?: string;
  };
  api: {
    base_url: string;
    version_prefix: string;
    client: string;
    interceptor_file?: string;
    response_format?: {
      data_key: string;
      error_key: string;
      pagination_keys?: { page: string; per_page: string; total: string };
    };
  };
  auth: {
    type: string;
    login_endpoint?: string;
    login_fields?: { username: string; password: string };
    token_storage: string;
    token_key: string;
    accounts: Record<string, {
      credentials: { username: string; password: string };
      entry_route: string;
      capabilities?: string[];
    }>;
  };
  features: Array<{
    name: string;
    pages_glob: string[];
    store_glob: string[];
    entry_url: string;
    api_prefix?: string;
    roles_with_access?: string[];
    sections?: Array<{ key: string; name: string; editable_by?: string[] }>;
  }>;
  selectors: {
    priority: string[];
    testid_attribute: string;
    forbidden_patterns: string[];
  };
  test_runner: {
    unit: string;
    e2e: string;
    browser?: string;
    base_url?: string;
    viewport?: { width: number; height: number };
    locale?: string;
  };
  conventions: {
    file_naming: string;
    component_pattern: string;
    api_pattern: string;
    form_library: string;
    i18n: boolean;
    i18n_library?: string;
  };
}

// ============================================================================
// PROJECT ADAPTER
// ============================================================================

export class ProjectAdapter {
  private config: ProjectConfig;
  private configPath: string;

  private constructor(config: ProjectConfig, configPath: string) {
    this.config = config;
    this.configPath = configPath;
  }

  /**
   * Load a project config from a JSON file.
   */
  static load(configPath: string): ProjectAdapter {
    const absPath = path.resolve(configPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Config not found: ${absPath}`);
    }
    const content = fs.readFileSync(absPath, 'utf-8');
    const config = JSON.parse(content) as ProjectConfig;
    return new ProjectAdapter(config, absPath);
  }

  // --------------------------------------------------------------------------
  // Project Info
  // --------------------------------------------------------------------------

  get name(): string { return this.config.project.name; }
  get root(): string { return this.config.project.root; }
  get srcDir(): string { return path.join(this.config.project.root, this.config.project.src_dir); }
  get language(): string { return this.config.project.language; }

  // --------------------------------------------------------------------------
  // Feature Understanding Agent inputs
  // --------------------------------------------------------------------------

  /**
   * Returns absolute glob patterns for all feature source files.
   * Feature Understanding Agent uses these to scan the codebase.
   */
  getSourceGlobs(featureIndex: number = 0): string[] {
    const feature = this.config.features[featureIndex];
    if (!feature) return [];
    return feature.pages_glob.map(g => path.join(this.srcDir, g));
  }

  getStoreGlobs(featureIndex: number = 0): string[] {
    const feature = this.config.features[featureIndex];
    if (!feature) return [];
    return feature.store_glob.map(g => path.join(this.srcDir, g));
  }

  getRouteFiles(): string[] {
    return this.config.routing.route_files.map(f => path.join(this.srcDir, f));
  }

  getStorePath(): string {
    return path.join(this.srcDir, this.config.state.store_path);
  }

  // --------------------------------------------------------------------------
  // Test Generator Agent inputs
  // --------------------------------------------------------------------------

  getAPIBase(): string {
    return `${this.config.api.base_url}${this.config.api.version_prefix}`;
  }

  getBaseURL(): string {
    return this.config.test_runner.base_url || this.config.api.base_url.replace('/api', '');
  }

  getFeatureEntryURL(featureIndex: number = 0): string {
    return this.config.features[featureIndex]?.entry_url || '/';
  }

  getFeatureSections(featureIndex: number = 0): Array<{ key: string; name: string; editable_by?: string[] }> {
    return this.config.features[featureIndex]?.sections || [];
  }

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  getAuthConfig() {
    return {
      type: this.config.auth.type,
      loginEndpoint: `${this.config.api.base_url}${this.config.auth.login_endpoint || '/auth/login'}`,
      loginFields: this.config.auth.login_fields || { username: 'email', password: 'password' },
      tokenStorage: this.config.auth.token_storage,
      tokenKey: this.config.auth.token_key,
    };
  }

  getRoles(): string[] {
    return Object.keys(this.config.auth.accounts);
  }

  getAuthForRole(role: string): { username: string; password: string; entryRoute: string; capabilities: string[] } | null {
    const account = this.config.auth.accounts[role];
    if (!account) return null;
    return {
      username: account.credentials.username,
      password: account.credentials.password,
      entryRoute: account.entry_route,
      capabilities: account.capabilities || [],
    };
  }

  // --------------------------------------------------------------------------
  // Selector Strategy (for UI Test Agent)
  // --------------------------------------------------------------------------

  getSelectorStrategy() {
    return {
      priority: this.config.selectors.priority,
      testidAttribute: this.config.selectors.testid_attribute,
      forbiddenPatterns: this.config.selectors.forbidden_patterns,
    };
  }

  // --------------------------------------------------------------------------
  // State Management (for State Logic Agent)
  // --------------------------------------------------------------------------

  getStateConfig() {
    return {
      manager: this.config.state.manager,
      sideEffects: this.config.state.side_effects,
      exposeOnWindow: this.config.state.expose_on_window || false,
      exposeKey: this.config.state.expose_key || '__REDUX_STORE__',
    };
  }

  // --------------------------------------------------------------------------
  // Validation Engine config (for rule customization)
  // --------------------------------------------------------------------------

  getValidationConfig() {
    return {
      forbiddenSelectors: this.config.selectors.forbidden_patterns,
      locale: this.config.test_runner.locale || 'en-US',
      formLibrary: this.config.conventions.form_library,
    };
  }

  // --------------------------------------------------------------------------
  // Playwright config generation
  // --------------------------------------------------------------------------

  generatePlaywrightConfig(): string {
    const c = this.config;
    return `
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: ['**/*.spec.ts'],
  testIgnore: ['**/*.api.spec.ts'],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['html', { outputFolder: 'reports/playwright-html' }],
    ['json', { outputFile: 'reports/execution-results.json' }],
    ['list'],
  ],
  use: {
    baseURL: '${c.test_runner.base_url || ''}',
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'retain-on-failure',
    viewport: { width: ${c.test_runner.viewport?.width || 1440}, height: ${c.test_runner.viewport?.height || 900} },
    locale: '${c.test_runner.locale || 'en-US'}',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
  ],
  outputDir: 'reports/test-results',
});
`.trim();
  }

  // --------------------------------------------------------------------------
  // Auth setup code generation
  // --------------------------------------------------------------------------

  generateAuthSetup(): string {
    const auth = this.config.auth;
    const roles = Object.keys(auth.accounts);

    return `
import { type Page, expect } from '@playwright/test';

type Role = ${roles.map(r => `'${r}'`).join(' | ')};

const ACCOUNTS: Record<Role, { username: string; password: string; route: string }> = {
${roles.map(r => {
  const acc = auth.accounts[r];
  return `  '${r}': { username: '${acc.credentials.username}', password: '${acc.credentials.password}', route: '${acc.entry_route}' },`;
}).join('\n')}
};

const BASE_URL = '${this.getBaseURL()}';
const TOKEN_KEY = '${auth.token_key}';
const TOKEN_CACHE: Partial<Record<Role, string>> = {};

export async function loginAs(page: Page, role: Role): Promise<void> {
  const account = ACCOUNTS[role];

  if (TOKEN_CACHE[role]) {
    await page.goto(BASE_URL);
    await page.evaluate(({ key, token }) => localStorage.setItem(key, token), { key: TOKEN_KEY, token: TOKEN_CACHE[role]! });
    await page.goto(BASE_URL + account.route);
    await page.waitForLoadState('networkidle');
    return;
  }

  await page.goto(BASE_URL + '/login');
  await page.waitForLoadState('networkidle');

  const usernameInput = page.locator('input[type="tel"], input[name="${auth.login_fields?.username || 'email'}"], input[type="email"]').first();
  await usernameInput.fill(account.username);

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.fill(account.password);

  await page.getByRole('button', { name: /login|sign in|đăng nhập/i }).first().click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');

  const token = await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);
  if (token) TOKEN_CACHE[role] = token;

  await page.goto(BASE_URL + account.route);
  await page.waitForLoadState('networkidle');
}

export async function getAuthToken(role: Role): Promise<string> {
  if (TOKEN_CACHE[role]) return TOKEN_CACHE[role]!;
  const account = ACCOUNTS[role];
  const res = await fetch('${this.config.api.base_url}${auth.login_endpoint || '/auth/login'}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ${auth.login_fields?.username || 'email'}: account.username, ${auth.login_fields?.password || 'password'}: account.password }),
  });
  const data = await res.json();
  const token = data?.data?.token || data?.token;
  if (token) TOKEN_CACHE[role] = token;
  return token || '';
}
`.trim();
  }

  // --------------------------------------------------------------------------
  // Summary for agents (context injection)
  // --------------------------------------------------------------------------

  toAgentContext(): string {
    const c = this.config;
    return [
      `Project: ${c.project.name}`,
      `Framework: ${c.framework.name} + ${c.framework.bundler}`,
      `UI Library: ${c.framework.ui_library}`,
      `State: ${c.state.manager} + ${c.state.side_effects}`,
      `API: ${c.api.client} → ${c.api.base_url}${c.api.version_prefix}`,
      `Routing: ${c.routing.type}`,
      `Forms: ${c.conventions.form_library}`,
      `Roles: ${this.getRoles().join(', ')}`,
      `Features: ${c.features.map(f => f.name).join(', ')}`,
      `Selectors: ${c.selectors.priority.join(' > ')}`,
    ].join('\n');
  }

  /**
   * Get raw config for serialization
   */
  toJSON(): ProjectConfig {
    return this.config;
  }
}

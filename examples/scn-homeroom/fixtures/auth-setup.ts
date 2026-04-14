/**
 * Shared authentication setup for Playwright SCN tests.
 *
 * Usage:
 *   import { loginAs, getAuthToken } from '../fixtures/auth-setup';
 *   test.beforeEach(async ({ page }) => { await loginAs(page, 'gvcn'); });
 */
import { type Page, expect } from '@playwright/test';
import accounts from './accounts.json';

type Role = keyof typeof accounts.accounts;

const AUTH_STORAGE_KEY = 'token';
const TOKEN_CACHE: Partial<Record<Role, string>> = {};

/**
 * Login via UI and cache the auth token for subsequent use.
 */
export async function loginAs(page: Page, role: Role): Promise<void> {
  const account = accounts.accounts[role];
  const baseUrl = accounts.environment.base_url;

  // If we already have a cached token, inject it directly
  if (TOKEN_CACHE[role]) {
    await page.goto(baseUrl);
    await page.evaluate(
      ({ key, token }) => localStorage.setItem(key, token),
      { key: AUTH_STORAGE_KEY, token: TOKEN_CACHE[role]! }
    );
    await page.goto(`${baseUrl}${account.route}`);
    await page.waitForLoadState('networkidle');
    return;
  }

  // Full login flow
  await page.goto(`${baseUrl}/login`);
  await page.waitForLoadState('networkidle');

  // Fill phone number
  const phoneInput = page.locator('input[placeholder*="số điện thoại"], input[name="phone"], input[type="tel"]').first();
  await phoneInput.fill(account.phone);

  // Fill password
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.fill(account.password);

  // Click login button
  const loginBtn = page.getByRole('button', { name: /đăng nhập|login/i }).first();
  await loginBtn.click();

  // Wait for successful navigation (away from login page)
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');

  // Cache the token
  const token = await page.evaluate((key) => localStorage.getItem(key), AUTH_STORAGE_KEY);
  if (token) {
    TOKEN_CACHE[role] = token;
  }

  // Navigate to SCN page
  await page.goto(`${baseUrl}${account.route}`);
  await page.waitForLoadState('networkidle');
}

/**
 * Get auth token for direct API testing (no browser needed).
 */
export async function getAuthToken(role: Role): Promise<string> {
  if (TOKEN_CACHE[role]) return TOKEN_CACHE[role]!;

  const account = accounts.accounts[role];
  const apiBase = accounts.environment.api_base;

  const response = await fetch(`${apiBase}/v3/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: account.phone,
      password: account.password,
    }),
  });

  if (!response.ok) {
    throw new Error(`Login failed for role ${role}: ${response.status}`);
  }

  const data = await response.json();
  const token = data?.data?.token || data?.token;

  if (!token) {
    throw new Error(`No token in login response for role ${role}`);
  }

  TOKEN_CACHE[role] = token;
  return token;
}

/**
 * Navigate to SCN dialog for a specific class (GVCN view).
 * Assumes already logged in.
 */
export async function openScnDialog(page: Page): Promise<void> {
  // GVCN view shows a single class card — click "Chỉnh sửa" or "Xem chi tiết"
  const editBtn = page.getByRole('button', { name: /chỉnh sửa|xem chi tiết/i }).first();
  await expect(editBtn).toBeVisible({ timeout: 10000 });
  await editBtn.click();

  // Wait for dialog to open (full-screen LiquidGlassDialog)
  await page.waitForSelector('[class*="LiquidGlass"], [class*="NotebookDialog"]', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to a specific section within the SCN dialog.
 */
export async function navigateToSection(page: Page, sectionTitle: string): Promise<void> {
  // Click sidebar item by text
  const sidebarItem = page.locator('[class*="Sidebar"], [class*="sidebar"]')
    .getByText(sectionTitle, { exact: false })
    .first();

  await sidebarItem.click();
  await page.waitForLoadState('networkidle');
  // Small wait for section transition
  await page.waitForTimeout(500);
}

/**
 * Capture Redux state snapshot from the running app.
 */
export async function captureReduxState(page: Page, sliceName: string = 'homeroomNotebook'): Promise<any> {
  return page.evaluate((slice) => {
    const store = (window as any).__REDUX_STORE__;
    if (!store) return { error: 'Redux store not exposed on window' };
    const state = store.getState();
    return slice ? state[slice] : state;
  }, sliceName);
}

/**
 * Capture all network requests matching a pattern during an action.
 */
export async function captureNetworkDuring(
  page: Page,
  urlPattern: string | RegExp,
  action: () => Promise<void>
): Promise<Array<{ method: string; url: string; status: number; body: any }>> {
  const captured: Array<{ method: string; url: string; status: number; body: any }> = [];

  const handler = async (response: any) => {
    const url = response.url();
    const matches = typeof urlPattern === 'string'
      ? url.includes(urlPattern)
      : urlPattern.test(url);

    if (matches) {
      try {
        const body = await response.json().catch(() => null);
        captured.push({
          method: response.request().method(),
          url,
          status: response.status(),
          body,
        });
      } catch { /* ignore parse errors */ }
    }
  };

  page.on('response', handler);
  await action();
  page.off('response', handler);

  return captured;
}

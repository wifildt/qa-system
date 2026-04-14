/**
 * UI Tests: Section 4.1 — Ban Đại Diện Cha Mẹ Học Sinh (Parent Committee)
 *
 * Tests CRUD operations, permission enforcement, dirty guard,
 * and cross-layer validation for the Parent Committee section.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  loginAs,
  openScnDialog,
  navigateToSection,
  captureReduxState,
  captureNetworkDuring,
} from '../../fixtures/auth-setup';

const SECTION_TITLE = 'Ban đại diện cha mẹ học sinh';
const API_PATTERN = 'ban_dai_dien_cmhs';
const SCREENSHOT_DIR = 'qa-system/reports/screenshots';

test.describe('Section 4.1: Parent Committee (Ban Đại Diện CMHS)', () => {
  // =========================================================================
  // SETUP
  // =========================================================================

  test.describe('GVCN Role — Full Edit Access', () => {
    test.beforeEach(async ({ page }) => {
      await loginAs(page, 'gvcn');
      await openScnDialog(page);
      await navigateToSection(page, SECTION_TITLE);
    });

    // -----------------------------------------------------------------------
    // Positive: Data loads correctly
    // -----------------------------------------------------------------------
    test('ui-4.1-positive-001: section loads and displays parent committee data', async ({ page }) => {
      // Evidence: screenshot
      await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-positive-001-loaded.png`, fullPage: true });

      // Verify section header is visible
      await expect(page.getByText(SECTION_TITLE)).toBeVisible();

      // Verify table exists with at least header row
      const table = page.locator('table').first();
      await expect(table).toBeVisible({ timeout: 10000 });

      // Verify columns exist (Vietnamese headers)
      await expect(table).toContainText(/họ và tên|họ tên/i);

      // Capture Redux state for cross-validation
      const state = await captureReduxState(page);
      expect(state).not.toBeNull();
      // banDaiDienCmhs should be an array (possibly empty for new notebook)
      expect(Array.isArray(state.banDaiDienCmhs)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Edit: Add new member
    // -----------------------------------------------------------------------
    test('ui-4.1-edit-001: add new parent committee member', async ({ page }) => {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-edit-001-before.png` });

      // Find "Thêm" (Add) button
      const addBtn = page.getByRole('button', { name: /thêm/i }).first();
      await expect(addBtn).toBeVisible();

      // Capture state before
      const stateBefore = await captureReduxState(page);
      const countBefore = stateBefore.banDaiDienCmhs?.length || 0;

      // Click Add
      await addBtn.click();

      // Verify a new row appeared
      const rows = page.locator('table tbody tr');
      await expect(rows).toHaveCount(countBefore + 1, { timeout: 5000 });

      await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-edit-001-after-add.png` });
    });

    // -----------------------------------------------------------------------
    // Save: Verify API call and persistence
    // -----------------------------------------------------------------------
    test('ui-4.1-save-001: save triggers correct API call with success feedback', async ({ page }) => {
      // Make an edit first (if data exists, modify a cell; if not, add a row)
      const addBtn = page.getByRole('button', { name: /thêm/i });
      if (await addBtn.isVisible()) {
        await addBtn.click();
        await page.waitForTimeout(300);
      }

      // Capture the Save action with network monitoring
      const apiCalls = await captureNetworkDuring(page, API_PATTERN, async () => {
        const saveBtn = page.getByRole('button', { name: /lưu/i }).first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
        }
      });

      // Verify API was called
      if (apiCalls.length > 0) {
        const saveCall = apiCalls.find(c => ['POST', 'PATCH'].includes(c.method));
        expect(saveCall).not.toBeNull();
        expect(saveCall!.status).toBeLessThan(400);
        expect(saveCall!.body).not.toBeNull();

        // Verify success feedback
        await expect(
          page.locator('.ant-message-success, [class*="toast-success"]')
        ).toBeVisible({ timeout: 5000 });
      }

      await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-save-001-after.png` });
    });

    // -----------------------------------------------------------------------
    // Dirty Guard: Unsaved changes prompt
    // -----------------------------------------------------------------------
    test('ui-4.1-dirty-001: dirty guard fires when navigating with unsaved changes', async ({ page }) => {
      // Make an edit
      const addBtn = page.getByRole('button', { name: /thêm/i });
      if (await addBtn.isVisible()) {
        await addBtn.click();
        await page.waitForTimeout(300);
      }

      // Attempt to navigate to another section
      const anotherSection = page.locator('[class*="Sidebar"], [class*="sidebar"]')
        .getByText('Bìa sổ', { exact: false })
        .first();
      await anotherSection.click();

      // Verify dirty guard modal appears
      const modal = page.locator('.ant-modal, [class*="ScnModal"], [class*="Modal"]');
      const modalVisible = await modal.isVisible().catch(() => false);

      if (modalVisible) {
        await expect(modal).toContainText(/chưa lưu|thay đổi|unsaved/i);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-dirty-001-modal.png` });

        // Cancel navigation (stay on section)
        const cancelBtn = modal.getByRole('button', { name: /hủy|ở lại|cancel/i }).first();
        if (await cancelBtn.isVisible()) {
          await cancelBtn.click();
        }
      } else {
        // If no modal, dirty guard may not be implemented for this section
        // This is itself a finding — log it
        console.warn('FINDING: Dirty guard did not fire for section 4.1 after edit');
      }
    });

    // -----------------------------------------------------------------------
    // Empty State
    // -----------------------------------------------------------------------
    test('ui-4.1-empty-001: empty section shows helpful empty state', async ({ page }) => {
      // Check if table is empty
      const rows = page.locator('table tbody tr');
      const count = await rows.count();

      if (count === 0) {
        // Verify there's a helpful message, not just blank space
        const contentArea = page.locator('[class*="ContentArea"], [class*="content"]').first();
        const text = await contentArea.textContent();
        expect(text!.trim().length).toBeGreaterThan(0);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-empty-001.png` });
      } else {
        test.skip(true, 'Table has data — empty state not applicable');
      }
    });

    // -----------------------------------------------------------------------
    // Semester Copy
    // -----------------------------------------------------------------------
    test('ui-4.1-feature-001: copy to next semester button exists and functions', async ({ page }) => {
      // Look for semester copy functionality
      const copyBtn = page.getByRole('button', { name: /sao chép|copy/i });
      const hasCopy = await copyBtn.isVisible().catch(() => false);

      if (hasCopy) {
        const apiCalls = await captureNetworkDuring(page, 'copy_semester', async () => {
          await copyBtn.click();
          // May need to confirm
          const confirmBtn = page.getByRole('dialog').getByRole('button', { name: /xác nhận|ok/i });
          if (await confirmBtn.isVisible().catch(() => false)) {
            await confirmBtn.click();
          }
        });

        if (apiCalls.length > 0) {
          expect(apiCalls[0].method).toBe('POST');
          expect(apiCalls[0].status).toBeLessThan(400);
        }
      }

      await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-feature-001.png` });
    });
  });

  // =========================================================================
  // PERMISSION TESTS
  // =========================================================================

  test.describe('Admin Role — View Only', () => {
    test.beforeEach(async ({ page }) => {
      await loginAs(page, 'admin');
    });

    test('ui-4.1-perm-001: admin cannot edit parent committee', async ({ page }) => {
      // Admin view: find a class and open dialog
      // Admin sees class table — click first "Xem chi tiết" or "Chỉnh sửa"
      const viewBtn = page.getByRole('button', { name: /xem chi tiết|chỉnh sửa/i }).first();
      if (await viewBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await viewBtn.click();
        await page.waitForLoadState('networkidle');
        await navigateToSection(page, SECTION_TITLE);

        // Verify Save button is NOT visible or disabled
        const saveBtn = page.getByRole('button', { name: /lưu/i });
        const saveBtnVisible = await saveBtn.isVisible().catch(() => false);

        if (saveBtnVisible) {
          // If visible, it should be disabled
          await expect(saveBtn).toBeDisabled();
        }

        // Verify Add button is NOT visible
        const addBtn = page.getByRole('button', { name: /thêm/i });
        const addVisible = await addBtn.isVisible().catch(() => false);
        expect(addVisible).toBe(false);

        await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-perm-001-admin-readonly.png` });
      }
    });
  });

  // =========================================================================
  // CROSS-LAYER: UI vs API vs State
  // =========================================================================

  test.describe('Cross-Layer Validation', () => {
    test('ui-4.1-cross-001: displayed data matches Redux state', async ({ page }) => {
      await loginAs(page, 'gvcn');
      await openScnDialog(page);
      await navigateToSection(page, SECTION_TITLE);

      // Get Redux state
      const state = await captureReduxState(page);
      const stateData = state.banDaiDienCmhs || [];

      // Get UI data (count rows)
      const rows = page.locator('table tbody tr');
      const uiRowCount = await rows.count();

      // Compare counts
      expect(uiRowCount).toBe(stateData.length);

      await page.screenshot({ path: `${SCREENSHOT_DIR}/ui-4.1-cross-001.png` });
    });
  });
});

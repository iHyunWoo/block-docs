import { test, expect } from '@playwright/test';
import { WEB_A, USER_A_ID, openAsUser, resetDoc, typeIntoFocused } from '../fixtures/setup.js';

test.describe('basic single-instance editing', () => {
  test.beforeEach(async () => {
    await resetDoc();
  });

  test('user can type into a paragraph and see it persist after reload', async ({ browser }) => {
    const { page, context } = await openAsUser(browser, WEB_A, USER_A_ID);

    // Click the first block to focus
    const firstBlock = page.getByTestId('block').first();
    await firstBlock.click();
    await typeIntoFocused(page, 'Hello world');

    await expect(firstBlock).toContainText('Hello world');

    // Wait for the delta to round-trip through ws + api (consumer writes async)
    await page.waitForTimeout(1500);

    await page.reload();
    await expect(page.getByTestId('block-editor')).toBeVisible();
    await expect(page.getByTestId('block').first()).toContainText('Hello world');

    await context.close();
  });

  test('Enter creates a new paragraph block', async ({ browser }) => {
    const { page, context } = await openAsUser(browser, WEB_A, USER_A_ID);

    const firstBlock = page.getByTestId('block').first();
    await firstBlock.click();
    await typeIntoFocused(page, 'First line');
    await page.keyboard.press('Enter');
    await typeIntoFocused(page, 'Second line');

    const blocks = page.getByTestId('block');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0)).toContainText('First line');
    await expect(blocks.nth(1)).toContainText('Second line');

    await context.close();
  });

  test('slash command inserts a heading block', async ({ browser }) => {
    const { page, context } = await openAsUser(browser, WEB_A, USER_A_ID);

    const firstBlock = page.getByTestId('block').first();
    await firstBlock.click();
    await page.keyboard.type('/', { delay: 20 });

    const slashMenu = page.getByTestId('slash-menu');
    await expect(slashMenu).toBeVisible();
    await slashMenu.getByText(/heading/i).first().click();

    // Heading block should now be present
    await expect(page.locator('[data-testid="block"][data-block-type="heading"]')).toHaveCount(1);

    await context.close();
  });
});

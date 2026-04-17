import { test, expect } from '@playwright/test';
import { WEB_A, USER_A_ID, openAsUser, resetDoc } from '../fixtures/setup.js';

/**
 * Covers the "tiptap-equivalent markdown input" requirement: heading, list, code,
 * blockquote, inline bold/italic all land as proper block types when the user
 * pastes markdown.
 */
test.describe('markdown paste', () => {
  test.beforeEach(async () => {
    await resetDoc();
  });

  test('pasted markdown expands into multiple block types', async ({ browser }) => {
    const { page, context } = await openAsUser(browser, WEB_A, USER_A_ID);

    const firstBlock = page.getByTestId('block').first();
    await firstBlock.click();

    const markdown = [
      '# Heading one',
      '',
      'This is **bold** and *italic* and `inline`.',
      '',
      '- bullet one',
      '- bullet two',
      '',
      '1. numbered one',
      '2. numbered two',
      '',
      '```python',
      "print('hello')",
      '```',
      '',
      '> quote block',
    ].join('\n');

    // Set the clipboard in the browser context then dispatch a paste event.
    await page.evaluate((md) => {
      const blob = new Blob([md], { type: 'text/plain' });
      // Use the clipboard API so the paste handler receives real data.
      const dt = new DataTransfer();
      dt.setData('text/plain', md);
      dt.setData('text/markdown', md);
      const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true });
      document.activeElement?.dispatchEvent(evt);
    }, markdown);

    // Expect at least one of each block type to appear
    await expect(page.locator('[data-block-type="heading"]')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('[data-block-type="bulleted_list"]')).toHaveCount(2);
    await expect(page.locator('[data-block-type="numbered_list"]')).toHaveCount(2);
    await expect(page.locator('[data-block-type="code"]')).toHaveCount(1);
    await expect(page.locator('[data-block-type="blockquote"]')).toHaveCount(1);

    await context.close();
  });
});

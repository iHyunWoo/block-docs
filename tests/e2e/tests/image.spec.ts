import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEB_A, WEB_B, USER_A_ID, USER_B_ID,
  openAsUser, resetDoc,
} from '../fixtures/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Verifies:
 *   (1) image upload works via presigned URL
 *   (2) the generated imageId/publicUrl includes the uploader's userId
 *       so two users uploading the "same" bytes produce DIFFERENT public URLs
 *   (3) image blocks render on the other instance via remote_ops
 */
test.describe('image blocks with presigned URLs', () => {
  test.beforeEach(async () => {
    await resetDoc();
  });

  test('two users upload images and see distinct URLs', async ({ browser }) => {
    const alice = await openAsUser(browser, WEB_A, USER_A_ID);
    const bob = await openAsUser(browser, WEB_B, USER_B_ID);

    const fixture = path.resolve(__dirname, '../fixtures/sample.png');

    // Alice inserts image block + uploads
    await alice.page.getByTestId('block').first().click();
    await alice.page.keyboard.type('/');
    await alice.page.getByTestId('slash-menu').getByText(/image/i).first().click();

    const aliceFileInput = alice.page.getByTestId('image-upload-input');
    await aliceFileInput.setInputFiles(fixture);

    const aliceImage = alice.page.locator('[data-testid="block"][data-block-type="image"] img').first();
    await expect(aliceImage).toBeVisible({ timeout: 10_000 });
    const aliceSrc = await aliceImage.getAttribute('src');
    expect(aliceSrc).toBeTruthy();

    // Wait for remote_ops to propagate to Bob
    await expect(bob.page.locator('[data-testid="block"][data-block-type="image"] img').first())
      .toBeVisible({ timeout: 10_000 });

    // Bob adds HIS own image
    await bob.page.getByTestId('block').first().click();
    await bob.page.keyboard.press('End');
    await bob.page.keyboard.press('Enter');
    await bob.page.keyboard.type('/');
    await bob.page.getByTestId('slash-menu').getByText(/image/i).first().click();
    const bobFileInput = bob.page.getByTestId('image-upload-input');
    await bobFileInput.setInputFiles(fixture);

    const bobImage = bob.page.locator('[data-testid="block"][data-block-type="image"] img').nth(1);
    await expect(bobImage).toBeVisible({ timeout: 10_000 });
    const bobSrc = await bobImage.getAttribute('src');
    expect(bobSrc).toBeTruthy();

    // Same file bytes, but Alice and Bob's URLs must differ (uploader's userId embedded)
    expect(bobSrc).not.toBe(aliceSrc);

    await alice.context.close();
    await bob.context.close();
  });
});

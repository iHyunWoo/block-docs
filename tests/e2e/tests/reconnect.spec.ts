import { test, expect } from '@playwright/test';
import {
  WEB_A, WEB_B, USER_A_ID, USER_B_ID,
  openAsUser, resetDoc, typeIntoFocused,
} from '../fixtures/setup.js';

test.describe('reconnect + stream replay', () => {
  test.beforeEach(async () => {
    await resetDoc();
  });

  test('offline client catches up via sinceStreamId replay after reconnect', async ({ browser }) => {
    const alice = await openAsUser(browser, WEB_A, USER_A_ID);
    const bob = await openAsUser(browser, WEB_B, USER_B_ID);

    // Alice types the initial content
    await alice.page.getByTestId('block').first().click();
    await typeIntoFocused(alice.page, 'initial');
    await alice.page.waitForTimeout(500);

    // Bob goes "offline" by closing his WebSocket (page.evaluate into the client)
    await bob.page.evaluate(() => (window as any).__blockDocsWs?.close());

    // Alice keeps typing while Bob is offline
    await typeIntoFocused(alice.page, ' plus more');
    await alice.page.waitForTimeout(800);

    // Bob reconnects
    await bob.page.evaluate(() => (window as any).__blockDocsWs?.reconnect());

    // Bob should catch up via replay
    await expect(bob.page.getByTestId('block').first())
      .toContainText('initial plus more', { timeout: 8_000 });

    await alice.context.close();
    await bob.context.close();
  });
});

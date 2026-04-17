import { test, expect } from '@playwright/test';
import {
  WEB_A, WEB_B, USER_A_ID, USER_B_ID,
  openAsUser, resetDoc, typeIntoFocused,
} from '../fixtures/setup.js';

/**
 * The hallmark demo assertion: two users on DIFFERENT web + ws instances see
 * each other's edits in real time. If this passes, Redis Pub/Sub fan-out and
 * Stream consumption are working end-to-end.
 */
test.describe('multi-instance collaboration (web-1/ws-1 ↔ web-2/ws-2)', () => {
  test.beforeEach(async () => {
    await resetDoc();
  });

  test('structural op (new block) propagates across instances', async ({ browser }) => {
    const alice = await openAsUser(browser, WEB_A, USER_A_ID);
    const bob = await openAsUser(browser, WEB_B, USER_B_ID);

    // Alice adds a heading
    const aliceFirst = alice.page.getByTestId('block').first();
    await aliceFirst.click();
    await alice.page.keyboard.press('Enter');
    await typeIntoFocused(alice.page, 'Shared heading from Alice');

    // Bob must see the heading within a few seconds
    await expect(bob.page.getByTestId('block').nth(1))
      .toContainText('Shared heading from Alice', { timeout: 6_000 });

    await alice.context.close();
    await bob.context.close();
  });

  test('text edits inside the same block merge via CRDT (no lost writes)', async ({ browser }) => {
    const alice = await openAsUser(browser, WEB_A, USER_A_ID);
    const bob = await openAsUser(browser, WEB_B, USER_B_ID);

    // Both users focus the first block
    await alice.page.getByTestId('block').first().click();
    await bob.page.getByTestId('block').first().click();

    // Alice types first
    await typeIntoFocused(alice.page, 'AAA');
    // Tiny pause so Bob's Yjs sees the state (not required for CRDT correctness, just a stable test)
    await alice.page.waitForTimeout(300);

    // Bob types too (concurrent-ish)
    await typeIntoFocused(bob.page, 'BBB');

    // Wait for convergence
    await alice.page.waitForTimeout(1_200);
    await bob.page.waitForTimeout(1_200);

    const aliceText = await alice.page.getByTestId('block').first().textContent();
    const bobText = await bob.page.getByTestId('block').first().textContent();

    // Both sides should converge to the same final text (Yjs guarantees this)
    expect(aliceText).toBe(bobText);

    // No writes should be dropped: both "AAA" and "BBB" remain present somewhere
    expect(aliceText).toContain('AAA');
    expect(aliceText).toContain('BBB');

    await alice.context.close();
    await bob.context.close();
  });

  test('presence dots appear for each connected user', async ({ browser }) => {
    const alice = await openAsUser(browser, WEB_A, USER_A_ID);
    const bob = await openAsUser(browser, WEB_B, USER_B_ID);

    // Alice should see both avatars in her presence bar
    await expect(alice.page.getByTestId('presence-dot')).toHaveCount(2, { timeout: 5_000 });
    await expect(bob.page.getByTestId('presence-dot')).toHaveCount(2, { timeout: 5_000 });

    await alice.context.close();
    await bob.context.close();
  });

  test('edits persist to DB even if both clients disconnect', async ({ browser }) => {
    const alice = await openAsUser(browser, WEB_A, USER_A_ID);
    const bob = await openAsUser(browser, WEB_B, USER_B_ID);

    await alice.page.getByTestId('block').first().click();
    await typeIntoFocused(alice.page, 'Persisted by api, not by client');

    // Allow the API consumer to flush
    await alice.page.waitForTimeout(1_500);

    await alice.context.close();
    await bob.context.close();

    // Third user joins (fresh context) and should see it
    const carol = await openAsUser(browser, WEB_A, 3);
    await expect(carol.page.getByTestId('block').first())
      .toContainText('Persisted by api, not by client', { timeout: 6_000 });
    await carol.context.close();
  });
});

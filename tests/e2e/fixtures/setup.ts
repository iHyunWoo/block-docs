import { Browser, BrowserContext, Page, expect, request } from '@playwright/test';

export const WEB_A = process.env.WEB_A_URL ?? 'http://localhost:3001';
export const WEB_B = process.env.WEB_B_URL ?? 'http://localhost:3002';
export const API_URL = process.env.API_URL ?? 'http://localhost:8000';
export const DEMO_DOC_ID = 1;

export const USER_A_ID = 1; // alice
export const USER_B_ID = 2; // bob

/**
 * Open a browser context pinned to a specific web instance with a given userId cookie.
 * The cookie drives `GET /api/v1/users/me` on the API.
 */
export async function openAsUser(
  browser: Browser,
  webUrl: string,
  userId: number,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'uid',
      value: String(userId),
      url: webUrl,
      httpOnly: false,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${webUrl}/docs/${DEMO_DOC_ID}`);
  // Wait for the editor shell to be ready.
  await expect(page.getByTestId('block-editor')).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

/**
 * Reset the demo document to an empty state by calling an api helper
 * (api exposes POST /api/v1/docs/{id}/_reset for tests — requires header X-Test-Mode).
 * If the endpoint is missing, best-effort truncate via a direct SQL exec is skipped.
 */
export async function resetDoc(docId = DEMO_DOC_ID) {
  const ctx = await request.newContext();
  const res = await ctx.post(`${API_URL}/api/v1/docs/${docId}/_reset`, {
    headers: { 'X-Test-Mode': '1' },
  });
  await ctx.dispose();
  if (!res.ok()) {
    throw new Error(`Reset failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Utility: type into a focused contentEditable block. Uses page.keyboard so IME
 * behavior isn't bypassed by setContent.
 */
export async function typeIntoFocused(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 20 });
}

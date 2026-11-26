/** Keep guest regressions independent of a developer's service/build config. */
export async function installOfflineRuntime(page) {
  await page.route('**/src/runtime-config.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: "export const RUNTIME_CONFIG = Object.freeze({ flavor: 'user', apiBaseUrl: '' });",
  }));
}

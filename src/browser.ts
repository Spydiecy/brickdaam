import { chromium, type Browser, type BrowserContext } from 'playwright';

/**
 * Which browser to drive:
 *  - macOS: the Google Chrome installed on the machine (channel "chrome").
 *  - Linux x64 servers: the real Google Chrome (installed by deploy/setup.sh). Playwright's bundled
 *    headless shell gets blocked or served bot checks by BigBasket and Zepto; real Chrome does not.
 *  - Linux ARM: Playwright's own Chromium, since Google Chrome has no Linux ARM build.
 * BROWSER_CHANNEL overrides this: "chrome", "chromium" (= Playwright's bundled build), "msedge", ...
 */
const defaultChannel = process.platform === 'darwin' || process.arch === 'x64' ? 'chrome' : 'chromium';
const channelSetting = process.env.BROWSER_CHANNEL ?? defaultChannel;
const channel = channelSetting === 'chromium' ? undefined : channelSetting;

const linuxArgs =
  process.platform === 'linux'
    ? [
        '--disable-dev-shm-usage', // small /dev/shm on servers makes Chrome crash under load
        '--disable-gpu',
      ]
    : [];

let browserPromise: Promise<Browser> | null = null;

/** One shared, headless browser for the whole process. */
export function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium
    .launch({
      channel,
      headless: process.env.HEADLESS !== '0',
      args: ['--disable-blink-features=AutomationControlled', ...linuxArgs],
    })
    .then((b) => {
      // If the browser crashes or is closed, launch a fresh one on the next call.
      b.on('disconnected', () => {
        browserPromise = null;
      });
      return b;
    });
  return browserPromise;
}

/** The desktop platform reported in the user agent, matching the OS the browser really runs on. */
const UA_PLATFORM =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';

/** Fresh context (clean cookies) that looks like a normal desktop Chrome in India. */
export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  // Headless Chrome announces itself as "HeadlessChrome"; send the regular UA instead.
  const major = browser.version().split('.')[0];
  return browser.newContext({
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1366, height: 900 },
    userAgent: `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  });
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  await b.close();
}

process.once('SIGINT', () => void closeBrowser().finally(() => process.exit(0)));
process.once('SIGTERM', () => void closeBrowser().finally(() => process.exit(0)));

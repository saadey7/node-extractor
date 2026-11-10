'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const POOL_SIZE = Math.max(1, Number(process.env.BROWSER_POOL_SIZE || 3));

const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox'];

async function launchStealthBrowser() {
  return chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
  });
}

async function probeStealth(browser, label) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });
  try {
    const page = await context.newPage();
    const probe = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      plugins: navigator.plugins?.length ?? 0,
      languages: Array.from(navigator.languages || []),
      chrome: typeof window.chrome !== 'undefined',
    }));
    return { label, ...probe };
  } finally {
    await context.close();
  }
}

class BrowserPool {
  constructor(size = POOL_SIZE) {
    this.size = size;
    this.browsers = [];
    this.next = 0;
    this.stealth = null;
    this._warmup = null;
  }

  status() {
    return {
      size: this.size,
      launched: this.browsers.length,
      connected: this.browsers.filter((browser) => browser.isConnected()).length,
    };
  }

  async warmup() {
    if (!this._warmup) {
      this._warmup = this._doWarmup();
    }
    return this._warmup;
  }

  async _doWarmup() {
    while (this.browsers.length < this.size) {
      this.browsers.push(await launchStealthBrowser());
    }

    const browser = this.browsers[0];
    const first = await probeStealth(browser, 'first-context');
    const reused = await probeStealth(browser, 'reused-context');
    this.stealth = { first, reused, appliesOnReuse: reused.webdriver !== true };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ stealth_probe: this.stealth }));
  }

  async acquire() {
    await this.warmup();

    for (let offset = 0; offset < this.browsers.length; offset += 1) {
      const index = (this.next + offset) % this.browsers.length;
      const current = this.browsers[index];
      if (current?.isConnected()) {
        this.next = (index + 1) % this.browsers.length;
        return current;
      }
      this.browsers[index] = await launchStealthBrowser();
      this.next = (index + 1) % this.browsers.length;
      return this.browsers[index];
    }

    const fresh = await launchStealthBrowser();
    this.browsers = [fresh];
    this.next = 0;
    return fresh;
  }
}

const browserPool = new BrowserPool();

module.exports = {
  browserPool,
  launchStealthBrowser,
  probeStealth,
};

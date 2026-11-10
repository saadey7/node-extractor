'use strict';

const fs = require('fs/promises');
const { browserPool } = require('./browserPool');

const NAVIGATION_TIMEOUT_MS = 45_000;
const GATE_PROBE_MS = 600;
const GATE_CLICK_TIMEOUT_MS = 3_000;
const MEDIA_SIGNAL_TIMEOUT_MS = 8_000;
const PLAYBACK_WAIT_MS = 2_000;
const JSON_DRAIN_MS = 800;
const SLIDE_CHANGE_TIMEOUT_MS = 1_200;
const MAX_CAROUSEL_SLIDES = 20;

const INSTAGRAM_IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 10.0.2.5.117 (iPhone15,2; iOS 17_6_1; en_US; en-US; scale=3.00; 1179x2556; 623326624)';

function shortcodeFromUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const match = parsed.pathname.match(/\/(?:reel|p|tv)\/([^/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function containsShortcode(value, shortcode) {
  if (!shortcode) {
    return true;
  }
  try {
    return JSON.stringify(value).includes(shortcode);
  } catch {
    return false;
  }
}

function isCdnHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith('cdninstagram.com') ||
      host === 'cdninstagram.com' ||
      host.endsWith('fbcdn.net') ||
      host === 'fbcdn.net'
    );
  } catch {
    return false;
  }
}

function isLikelyVideoUrl(url, contentType = '') {
  if (!url || url.startsWith('blob:') || !isCdnHost(url)) {
    return false;
  }
  const type = contentType.toLowerCase();
  if (type.includes('video/')) {
    return true;
  }
  return url.includes('.mp4') || url.includes('video') || url.includes('bytestart');
}

function isLikelyImageUrl(url, contentType = '') {
  if (!url || url.startsWith('blob:') || url.startsWith('data:') || !isCdnHost(url)) {
    return false;
  }
  if (/s150x150|s50x50|s60x60|rsrc\.php|static\.cdninstagram\.com\/rsrc/i.test(url)) {
    return false;
  }
  const type = contentType.toLowerCase();
  if (type.includes('image/')) {
    return true;
  }
  return /\.(jpe?g|png|webp)/i.test(url) || url.includes('stp=') || url.includes('e35');
}

function debugEnabled() {
  return process.env.EXTRACTOR_DEBUG === 'true';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(condition, { timeout = 8_000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await condition()) {
        return true;
      }
    } catch {
      // keep polling
    }
    await sleep(interval);
  }
  return false;
}

async function dumpDebug(page, screenshotPath, htmlPath) {
  if (!debugEnabled()) {
    return;
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  if (htmlPath) {
    await fs.writeFile(htmlPath, await page.content(), 'utf8');
  }
}

async function presetInstagramFlags(context) {
  await context.addCookies([
    { name: 'ig_nrcb', value: '1', domain: '.instagram.com', path: '/' },
    { name: 'ig_cb', value: '1', domain: '.instagram.com', path: '/' },
  ]);
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('ig_nrcb', '1');
      window.localStorage.setItem('ig_cb', '1');
    } catch {
      // ignore
    }
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {
      // ignore
    }
  });
}

async function dismissLoginWall(page) {
  const close = page.locator('[aria-label="Close"]').first();
  try {
    await close.waitFor({ state: 'visible', timeout: GATE_PROBE_MS });
    await close.click({ timeout: GATE_CLICK_TIMEOUT_MS });
    await close.waitFor({ state: 'hidden', timeout: 1_500 }).catch(() => {});
  } catch {
    // no login wall
  }
  try {
    await page.keyboard.press('Escape');
  } catch {
    // ignore
  }
}

async function dismissAppGate(page) {
  const patterns = [/continue on web/i, /continue as guest/i];
  for (const pattern of patterns) {
    const locator = page.getByText(pattern).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: GATE_PROBE_MS });
      await locator.click({ timeout: GATE_CLICK_TIMEOUT_MS });
      await page.waitForSelector('video, article, img[src*="cdninstagram"], img[src*="fbcdn"]', {
        timeout: 5_000,
      }).catch(() => {});
      return { clicked: true, matched: String(pattern) };
    } catch {
      // next
    }
  }
  return { clicked: false, matched: null };
}

function bestImageFromNode(node) {
  const candidates = node?.image_versions2?.candidates;
  if (Array.isArray(candidates) && candidates.length) {
    const sorted = [...candidates].sort((a, b) => (b.width || 0) - (a.width || 0));
    if (sorted[0]?.url) {
      return sorted[0].url;
    }
  }
  const resources = node?.display_resources;
  if (Array.isArray(resources) && resources.length) {
    const sorted = [...resources].sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
    if (sorted[0]?.src) {
      return sorted[0].src;
    }
  }
  return node?.display_url || node?.display_src || node?.thumbnail_src || null;
}

function mapLeafNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const isVideo =
    node.media_type === 2 ||
    node.is_video === true ||
    Boolean(node.video_url) ||
    (Array.isArray(node.video_versions) && node.video_versions.length > 0);

  if (isVideo) {
    const url = node.video_versions?.[0]?.url || node.video_url || null;
    if (url && isCdnHost(url)) {
      const thumb = bestImageFromNode(node);
      return {
        type: 'video',
        url,
        thumbnailUrl: thumb && isCdnHost(thumb) ? thumb : null,
      };
    }
    return null;
  }

  const image = bestImageFromNode(node);
  if (image && isCdnHost(image)) {
    return { type: 'image', url: image, thumbnailUrl: null };
  }
  return null;
}

function resultFromMediaNode(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const sidecar = node.edge_sidecar_to_children?.edges;
  if (Array.isArray(sidecar) && sidecar.length > 1) {
    return resultFromItems(sidecar.map((edge) => mapLeafNode(edge?.node)).filter(Boolean));
  }
  const carousel = node.carousel_media;
  if (Array.isArray(carousel) && carousel.length > 1) {
    return resultFromItems(carousel.map(mapLeafNode).filter(Boolean));
  }
  const item = mapLeafNode(node);
  return resultFromItems(item ? [item] : []);
}

function findPreferredMediaNode(root) {
  let found = null;

  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 50 || found) {
      return;
    }
    if (node.xdt_shortcode_media && typeof node.xdt_shortcode_media === 'object') {
      found = node.xdt_shortcode_media;
      return;
    }
    if (node.shortcode_media && typeof node.shortcode_media === 'object') {
      found = node.shortcode_media;
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, depth + 1);
        if (found) {
          return;
        }
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        walk(value, depth + 1);
        if (found) {
          return;
        }
      }
    }
  }

  walk(root, 0);
  return found;
}

function collectFromGraphql(root, shortcode) {
  const found = { sidecar: null, carousel: null, leaf: null };

  function matches(node) {
    if (!shortcode) {
      return true;
    }
    return node.code === shortcode || node.shortcode === shortcode;
  }

  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 50) {
      return;
    }
    if (Array.isArray(node.edge_sidecar_to_children?.edges) && node.edge_sidecar_to_children.edges.length > 1) {
      if (!shortcode || matches(node) || containsShortcode(node.edge_sidecar_to_children, shortcode)) {
        found.sidecar = node.edge_sidecar_to_children.edges.map((edge) => edge?.node).filter(Boolean);
      }
    }
    if (Array.isArray(node.carousel_media) && node.carousel_media.length > 1) {
      if (!shortcode || matches(node) || containsShortcode(node.carousel_media, shortcode)) {
        found.carousel = node.carousel_media;
      }
    }
    if (node.video_versions?.[0]?.url || node.video_url) {
      if (matches(node) || !found.leaf) {
        found.leaf = node;
      }
    } else if (!found.leaf && (node.image_versions2 || node.display_url) && node.media_type !== 8) {
      if (!shortcode || matches(node)) {
        found.leaf = node;
      }
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, depth + 1);
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  }

  walk(root, 0);
  return found;
}

function resultFromGraphql(root, shortcode) {
  if (shortcode && !containsShortcode(root, shortcode)) {
    return null;
  }
  const preferred = findPreferredMediaNode(root);
  if (preferred) {
    const fromPreferred = resultFromMediaNode(preferred);
    if (fromPreferred) {
      return fromPreferred;
    }
  }

  const found = collectFromGraphql(root, shortcode);
  if (found.sidecar?.length > 1) {
    const result = resultFromItems(found.sidecar.map(mapLeafNode).filter(Boolean));
    if (result) {
      return result;
    }
  }
  if (found.carousel?.length > 1) {
    const result = resultFromItems(found.carousel.map(mapLeafNode).filter(Boolean));
    if (result) {
      return result;
    }
  }
  if (found.leaf) {
    const item = mapLeafNode(found.leaf);
    return resultFromItems(item ? [item] : []);
  }
  return null;
}

function pickBestResult(results) {
  const usable = results.filter(Boolean);
  if (!usable.length) {
    return null;
  }
  const carousels = usable.filter((result) => result.postType === 'carousel');
  if (carousels.length) {
    carousels.sort((a, b) => b.items.length - a.items.length);
    return carousels[0];
  }
  const videos = usable.filter((result) => result.postType === 'video');
  if (videos.length) {
    return videos[0];
  }
  return usable[0];
}

function isJsonApiUrl(url) {
  return url.includes('/graphql') || url.includes('/api/v1/media');
}

function resultFromItems(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) {
      continue;
    }
    seen.add(item.url);
    unique.push({
      type: item.type,
      url: item.url,
      thumbnailUrl: item.thumbnailUrl || null,
    });
  }
  if (!unique.length) {
    return null;
  }
  const postType = unique.length > 1 ? 'carousel' : unique[0].type;
  return { postType, items: unique };
}

async function extractFromEmbeddedJson(page, shortcode) {
  const parsed = await page.evaluate(() => {
    const blobs = [];
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (text.length < 40) {
        continue;
      }
      if (
        script.type === 'application/json' ||
        text.includes('edge_sidecar_to_children') ||
        text.includes('carousel_media') ||
        text.includes('xdt_shortcode_media') ||
        text.includes('video_versions') ||
        text.includes('image_versions2')
      ) {
        blobs.push(text);
      }
    }
    return blobs;
  });

  for (const blob of parsed) {
    if (shortcode && !blob.includes(shortcode)) {
      continue;
    }
    let json;
    try {
      json = JSON.parse(blob);
    } catch {
      continue;
    }
    const found = resultFromGraphql(json, shortcode);
    if (found) {
      return found;
    }
  }

  return null;
}

async function tryStartPlayback(page, intercepted) {
  const play = page.locator('[aria-label="Play"], [aria-label="Play video"], button[aria-label="Play"]').first();
  try {
    await play.waitFor({ state: 'visible', timeout: 800 });
    await play.click({ timeout: 2_000 });
    await waitFor(() => intercepted.videos.length > 0, { timeout: PLAYBACK_WAIT_MS, interval: 80 });
    return;
  } catch {
    // fall through to tapping the video element
  }

  try {
    await page.locator('video').first().click({ force: true, timeout: 1_500 });
    await waitFor(() => intercepted.videos.length > 0, { timeout: PLAYBACK_WAIT_MS, interval: 80 });
  } catch {
    // no player
  }
}

async function detectCarouselUi(page) {
  return page.evaluate(() => {
    const next = document.querySelector(
      'button[aria-label="Next"], button[aria-label="Next photo"], button[aria-label="Go to next"], [aria-label="Next"]',
    );
    const dots = document.querySelectorAll(
      '[role="tab"], [aria-label*="slide" i], [aria-label*="carousel" i], [class*="carousel"] span',
    );
    const translatedSlides = Array.from(document.querySelectorAll('li')).filter((li) => {
      const style = li.getAttribute('style') || '';
      return style.includes('translate') || li.getAttribute('aria-hidden') === 'true' || li.getAttribute('aria-hidden') === 'false';
    });
    return Boolean(next) || dots.length > 1 || translatedSlides.length > 1;
  });
}

async function currentSlideMedia(page, intercepted) {
  const fromDom = await page.evaluate(() => {
    const root = document.querySelector('article') || document.body;
    const video = root.querySelector('video');
    if (video) {
      const src = video.currentSrc || video.getAttribute('src') || '';
      const poster = video.getAttribute('poster') || '';
      if (src && !src.startsWith('blob:')) {
        return { type: 'video', url: src, thumbnailUrl: poster || null };
      }
      if (src.startsWith('blob:')) {
        return { type: 'video', url: null, thumbnailUrl: poster || null, blob: true };
      }
    }

    const isCarousel = Boolean(
      document.querySelector('button[aria-label="Next"], button[aria-label="Next photo"], [aria-label="Next"]'),
    );
    if (isCarousel) {
      const active = root.querySelector('li[aria-hidden="false"] img, [aria-hidden="false"] img');
      if (active && (active.naturalWidth || active.width) >= 200) {
        return { type: 'image', url: active.currentSrc || active.src, thumbnailUrl: null };
      }
    }
    const images = Array.from(root.querySelectorAll('img'))
      .map((img) => ({
        src: img.currentSrc || img.src || '',
        width: img.naturalWidth || img.width || 0,
      }))
      .filter((img) => img.src && img.width >= 200 && !/s150x150|s50x50|rsrc\.php/i.test(img.src));
    images.sort((a, b) => b.width - a.width);
    if (images[0]) {
      return { type: 'image', url: images[0].src, thumbnailUrl: null };
    }
    return null;
  });

  if (fromDom?.url) {
    return fromDom;
  }
  if (fromDom?.blob && intercepted.videos.length) {
    return {
      type: 'video',
      url: intercepted.videos[intercepted.videos.length - 1],
      thumbnailUrl: fromDom.thumbnailUrl,
    };
  }
  return fromDom;
}

async function waitForSlideChange(page, intercepted, previousUrl) {
  await waitFor(
    async () => {
      const next = await currentSlideMedia(page, intercepted);
      return Boolean(next?.url && next.url !== previousUrl);
    },
    { timeout: SLIDE_CHANGE_TIMEOUT_MS, interval: 80 },
  );
}

async function clickNextSlide(page, intercepted, previousUrl) {
  const selectors = [
    'button[aria-label="Next"]',
    'button[aria-label="Next photo"]',
    'button[aria-label="Go to next"]',
    '[aria-label="Next"]',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).last();
    try {
      if (await button.isVisible({ timeout: 250 })) {
        const disabled = await button.getAttribute('disabled');
        if (disabled !== null) {
          return false;
        }
        await button.click({ timeout: 2000 });
        await waitForSlideChange(page, intercepted, previousUrl);
        return true;
      }
    } catch {
      // try next selector
    }
  }

  return false;
}

async function extractCarouselByClicking(page, intercepted) {
  const items = [];
  const seen = new Set();

  for (let i = 0; i < MAX_CAROUSEL_SLIDES; i += 1) {
    const slide = await currentSlideMedia(page, intercepted);
    if (slide?.url && !seen.has(slide.url)) {
      seen.add(slide.url);
      items.push({
        type: slide.type,
        url: slide.url,
        thumbnailUrl: slide.thumbnailUrl || null,
      });
    }
    const moved = await clickNextSlide(page, intercepted, slide?.url);
    if (!moved) {
      break;
    }
    const after = await currentSlideMedia(page, intercepted);
    if (after?.url && seen.has(after.url) && i > 0) {
      break;
    }
  }

  return resultFromItems(items);
}

async function extractSingleFromDom(page, intercepted) {
  const slide = await currentSlideMedia(page, intercepted);
  if (slide?.url) {
    return resultFromItems([slide]);
  }
  if (intercepted.videos.length) {
    return resultFromItems([
      {
        type: 'video',
        url: intercepted.videos[intercepted.videos.length - 1],
        thumbnailUrl: intercepted.images[0] || null,
      },
    ]);
  }
  if (intercepted.images.length) {
    return resultFromItems([
      {
        type: 'image',
        url: intercepted.images[0],
        thumbnailUrl: null,
      },
    ]);
  }
  return null;
}

async function extractPost(targetUrl) {
  const browser = await browserPool.acquire();
  const intercepted = { videos: [], images: [], jsonResults: [] };
  const pendingJson = [];
  const shortcode = shortcodeFromUrl(targetUrl);
  const expectsVideo = /\/(?:reel|tv)\//.test(targetUrl);
  let context;

  try {
    context = await browser.newContext({
      userAgent: INSTAGRAM_IPHONE_UA,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    await presetInstagramFlags(context);
    const page = await context.newPage();

    page.on('response', (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      if (isLikelyVideoUrl(url, contentType)) {
        intercepted.videos.push(url);
      } else if (isLikelyImageUrl(url, contentType)) {
        intercepted.images.push(url);
      }

      const looksJson = contentType.includes('application/json') || isJsonApiUrl(url);
      if (looksJson) {
        pendingJson.push(
          response
            .json()
            .then((json) => {
              const parsed = resultFromGraphql(json, shortcode);
              if (parsed) {
                intercepted.jsonResults.push(parsed);
              }
            })
            .catch(() => {}),
        );
      }
    });

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await dumpDebug(page, '/tmp/debug-screenshot.png', '/tmp/debug-page.html');
    if (intercepted.jsonResults.length === 0 && intercepted.videos.length === 0) {
      await dismissAppGate(page);
      await dismissLoginWall(page);
    }

    await waitFor(async () => {
      if (intercepted.jsonResults.length > 0 || intercepted.videos.length > 0) {
        return true;
      }
      return (await page.locator('video, article img, img[src*="cdninstagram"], img[src*="fbcdn"]').count()) > 0;
    }, { timeout: MEDIA_SIGNAL_TIMEOUT_MS, interval: 100 });

    if (expectsVideo && intercepted.videos.length === 0 && intercepted.jsonResults.length === 0) {
      await tryStartPlayback(page, intercepted);
      await waitFor(
        () => intercepted.videos.length > 0 || intercepted.jsonResults.length > 0,
        { timeout: 4_000, interval: 100 },
      );
    }

    await Promise.race([Promise.allSettled(pendingJson), sleep(JSON_DRAIN_MS)]);
    await dumpDebug(page, '/tmp/debug-screenshot-after-gate.png', '/tmp/debug-page-after-gate.html');

    const fromNetwork = pickBestResult(intercepted.jsonResults);
    const fromJson = await extractFromEmbeddedJson(page, shortcode);
    const structured = pickBestResult([fromNetwork, fromJson]);

    if (structured && structured.postType === 'carousel') {
      return structured;
    }

    if (structured && structured.postType === 'video') {
      return structured;
    }

    if (structured && structured.postType === 'image' && !expectsVideo) {
      return structured;
    }

    const carouselUi = await detectCarouselUi(page);
    if (carouselUi && !structured) {
      const carousel = await extractCarouselByClicking(page, intercepted);
      if (carousel && carousel.items.length > 1) {
        return carousel;
      }
    }

    if (intercepted.videos.length) {
      return resultFromItems([
        {
          type: 'video',
          url: intercepted.videos[intercepted.videos.length - 1],
          thumbnailUrl: structured?.items?.[0]?.url || intercepted.images[0] || null,
        },
      ]);
    }

    if (structured && !(expectsVideo && structured.postType === 'image')) {
      return structured;
    }

    const single = await extractSingleFromDom(page, intercepted);
    if (single && !(expectsVideo && single.postType === 'image')) {
      return single;
    }

    const error = new Error('MEDIA_NOT_FOUND');
    error.code = 'MEDIA_NOT_FOUND';
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

module.exports = { extractPost, browserPool };

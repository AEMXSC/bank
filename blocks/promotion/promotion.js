import { getMetadata } from '../../scripts/aem.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';
import { getHostname, mapAemPathToSitePath } from '../../scripts/utils.js';

/* ────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────── */

const DEFAULT_MBOX = 'target-global-mbox';
const ATJS_POLL_INTERVAL_MS = 500;
const ATJS_MAX_WAIT_MS = 10000;

const CF_CONFIG = {
  WRAPPER_SERVICE_URL: 'https://3635370-refdemoapigateway-stage.adobeioruntime.net/api/v1/web/ref-demo-api-gateway/fetch-cf',
  GRAPHQL_QUERY: '/graphql/execute.json/ref-demo-eds/CTAByPath',
};

// eslint-disable-next-line no-console
const log = (...args) => console.log('[Promotion]', ...args);
// eslint-disable-next-line no-console
const logWarn = (...args) => console.warn('[Promotion]', ...args);
// eslint-disable-next-line no-console
const logError = (...args) => console.error('[Promotion]', ...args);

/* ────────────────────────────────────────────
 * Normalise Target offer JSON into the same
 * CF item shape used by AEM GraphQL
 * (handles both "exported CF" and "flat offer")
 * ──────────────────────────────────────────── */

function normaliseOfferToCfShape(data) {
  const item = data?.data?.ctaByPath?.item;
  if (item) {
    log('Normalised offer → CF export shape, title:', item.title);
    return item;
  }

  const flat = {
    title: data?.offer || data?.title || '',
    subtitle: data?.subtitle || '',
    description: data?.description ? { plaintext: data.description } : null,
    bannerimage: data?.bannerimage ? { _publishUrl: data.bannerimage } : null,
    ctalabel: data?.ctalabel || '',
    ctaurl: data?.ctaurl || null,
  };
  log('Normalised offer → flat shape, title:', flat.title);
  return flat;
}

/* ────────────────────────────────────────────
 * Content Fragment fetch (same GraphQL +
 * API-gateway pattern as the content-fragment block)
 * ──────────────────────────────────────────── */

async function fetchContentFragment(contentPath, variation, isAuthor, aemAuthorUrl, aemPublishUrl) {
  log('Fetching default CF:', { contentPath, variation, isAuthor });

  const requestConfig = isAuthor
    ? {
      url: `${aemAuthorUrl}${CF_CONFIG.GRAPHQL_QUERY};path=${contentPath};variation=${variation};ts=${Date.now()}`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
    : {
      url: CF_CONFIG.WRAPPER_SERVICE_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graphQLPath: `${aemPublishUrl}${CF_CONFIG.GRAPHQL_QUERY}`,
        cfPath: contentPath,
        variation: `${variation};ts=${Date.now()}`,
      }),
    };

  log('CF request →', requestConfig.method, requestConfig.url);

  const res = await fetch(requestConfig.url, {
    method: requestConfig.method,
    headers: requestConfig.headers,
    ...(requestConfig.body && { body: requestConfig.body }),
  });

  log('CF response status:', res.status);

  if (!res.ok) {
    logWarn('CF fetch failed with status', res.status);
    return null;
  }
  const json = await res.json();
  const item = json?.data?.ctaByPath?.item || null;
  log('CF item resolved:', item ? `"${item.title}"` : '(null)');
  return item;
}

/* ────────────────────────────────────────────
 * at.js – wait for it to load (it comes via
 * delayed.js ~3 s after page load), then use
 * getOffers() so Target gets full page context,
 * ECID visitor identity and browsing history
 * needed for page-URL-based audiences.
 * ──────────────────────────────────────────── */

function waitForAtJs() {
  log('Waiting for at.js to load...');
  return new Promise((resolve) => {
    if (window.adobe?.target?.getOffers) {
      log('at.js already available');
      resolve(true);
      return;
    }

    const start = Date.now();
    const timer = setInterval(() => {
      if (window.adobe?.target?.getOffers) {
        clearInterval(timer);
        log(`at.js ready after ${Date.now() - start}ms`);
        resolve(true);
      } else if (Date.now() - start > ATJS_MAX_WAIT_MS) {
        clearInterval(timer);
        logWarn(`at.js did not load within ${ATJS_MAX_WAIT_MS}ms timeout`);
        resolve(false);
      }
    }, ATJS_POLL_INTERVAL_MS);
  });
}

/**
 * Extract the first JSON offer content from an at.js getOffers() response.
 * Checks both pageLoad and named mboxes.
 */
function extractJsonOffer(response) {
  log('Extracting JSON offer from getOffers response...');

  const pageOpts = response?.execute?.pageLoad?.options || [];
  log(`  pageLoad options: ${pageOpts.length}`, pageOpts.map((o) => o.type));
  const jsonPageOffer = pageOpts.find((o) => o.type === 'json');
  if (jsonPageOffer?.content) {
    log('  ✓ Found JSON offer in pageLoad');
    log('  Content keys:', Object.keys(jsonPageOffer.content));
    return jsonPageOffer.content;
  }

  const mboxes = response?.execute?.mboxes || [];
  log(`  Named mboxes in response: ${mboxes.length}`, mboxes.map((m) => m.name));
  for (const mbox of mboxes) {
    const opts = mbox.options || [];
    const jsonOffer = opts.find((o) => o.type === 'json');
    if (jsonOffer?.content) {
      log(`  ✓ Found JSON offer in named mbox "${mbox.name}"`);
      log('  Content keys:', Object.keys(jsonOffer.content));
      return jsonOffer.content;
    }
  }

  logWarn('  ✗ No JSON offer found in pageLoad or named mboxes');
  log('  Full response structure:', JSON.stringify(response, null, 2).substring(0, 500));
  return null;
}

function getProfileParameters() {
  const params = {};
  try {
    const stored = localStorage.getItem('userProfile');
    if (stored) Object.assign(params, JSON.parse(stored));
  } catch { /* empty */ }

  const url = new URL(window.location.href);
  url.searchParams.forEach((value, key) => {
    if (key.startsWith('profile.')) {
      params[key.replace('profile.', '')] = value;
    }
  });
  log('Profile parameters:', Object.keys(params).length ? params : '(none)');
  return params;
}

async function fetchTargetOffer(mbox) {
  log('Starting Target offer fetch, mbox:', mbox);

  const atjsReady = await waitForAtJs();
  if (!atjsReady) {
    logWarn('at.js did not load – skipping Target personalisation');
    return null;
  }

  const profileParams = getProfileParameters();
  const isGlobalMbox = !mbox || mbox === 'target-global-mbox';

  const executeRequest = {};
  if (isGlobalMbox) {
    executeRequest.pageLoad = { parameters: profileParams };
    log('Requesting pageLoad offers (global mbox)');
  } else {
    executeRequest.pageLoad = { parameters: profileParams };
    executeRequest.mboxes = [{ index: 0, name: mbox, parameters: profileParams }];
    log('Requesting pageLoad + named mbox:', mbox);
  }

  try {
    log('Calling adobe.target.getOffers()...', {
      pageLoad: true,
      namedMbox: isGlobalMbox ? '(none – global)' : mbox,
      paramKeys: Object.keys(profileParams),
    });

    const response = await window.adobe.target.getOffers({
      request: { execute: executeRequest },
      timeout: 5000,
    });

    log('getOffers() response received');
    const raw = extractJsonOffer(response);

    if (!raw) {
      log('No personalised offer from Target for this visitor/audience');
      return null;
    }

    log('Calling applyOffers() for analytics tracking...');
    window.adobe.target.applyOffers({ response });
    log('applyOffers() complete');

    const normalised = normaliseOfferToCfShape(raw);
    log('Target offer ready to render:', normalised?.title);
    return normalised;
  } catch (err) {
    logError('getOffers() failed:', err);
    return null;
  }
}

/* ────────────────────────────────────────────
 * Render a promotion card from CF-shaped data
 * ──────────────────────────────────────────── */

async function renderCard(block, cfItem, isAuthor, source = 'default') {
  log(`Rendering card [${source}]:`, cfItem?.title);

  const imgUrl = isAuthor
    ? (cfItem.bannerimage?._authorUrl || cfItem.bannerimage?._publishUrl)
    : (cfItem.bannerimage?._publishUrl || cfItem.bannerimage?._authorUrl);

  let ctaHref = '#';
  const cta = cfItem.ctaurl;
  if (cta) {
    if (typeof cta === 'string') {
      ctaHref = cta;
    } else {
      ctaHref = isAuthor
        ? (cta._authorUrl || cta._path || '#')
        : (cta._publishUrl || cta._path || '#');
    }
  }

  if (!isAuthor && ctaHref.startsWith('/content/')) {
    try {
      const mapped = await mapAemPathToSitePath(ctaHref);
      if (mapped) ctaHref = mapped;
    } catch { /* keep original */ }
  }

  log(`  Image: ${imgUrl || '(none)'}`);
  log(`  CTA: "${cfItem.ctalabel}" → ${ctaHref}`);

  const card = document.createElement('div');
  card.className = 'promotion-card';

  if (imgUrl) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'promotion-image';
    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = cfItem.title || 'Promotion';
    img.loading = 'lazy';
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
  }

  const content = document.createElement('div');
  content.className = 'promotion-content';

  if (cfItem.title) {
    const h3 = document.createElement('h3');
    h3.className = 'promotion-title';
    h3.textContent = cfItem.title;
    content.appendChild(h3);
  }

  if (cfItem.subtitle) {
    const sub = document.createElement('p');
    sub.className = 'promotion-subtitle';
    sub.textContent = cfItem.subtitle;
    content.appendChild(sub);
  }

  const descText = cfItem.description?.plaintext || '';
  if (descText) {
    const desc = document.createElement('p');
    desc.className = 'promotion-description';
    desc.textContent = descText;
    content.appendChild(desc);
  }

  const label = cfItem.ctalabel || '';
  if (label) {
    const ctaWrap = document.createElement('div');
    ctaWrap.className = 'promotion-cta';
    const anchor = document.createElement('a');
    anchor.href = ctaHref;
    anchor.className = 'button';
    anchor.textContent = label;
    if (/^https?:\/\//i.test(ctaHref)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener';
    }
    ctaWrap.appendChild(anchor);
    content.appendChild(ctaWrap);
  }

  card.appendChild(content);
  block.innerHTML = '';
  block.appendChild(card);
  log(`Card rendered [${source}] ✓`);
}

/* ────────────────────────────────────────────
 * Block decorator
 *
 * Flow on publish/live:
 *  1. Render the author-selected default CF immediately
 *  2. In the background, wait for at.js → call getOffers()
 *  3. If Target returns a personalized offer, swap the card
 *
 * This avoids a blank gap while at.js loads (~3 s)
 * and still delivers personalization once available.
 * ──────────────────────────────────────────── */

export default async function decorate(block) {
  const contentPath = block.querySelector(':scope div:nth-child(1) > div a')?.textContent?.trim()
    || block.querySelector(':scope div:nth-child(1) > div')?.textContent?.trim();
  const variation = block.querySelector(':scope div:nth-child(2) > div')?.textContent?.trim()?.toLowerCase()?.replace(' ', '_') || 'master';
  const mboxName = block.querySelector(':scope div:nth-child(3) > div')?.textContent?.trim() || DEFAULT_MBOX;

  log('========== Promotion block init ==========');
  log('Config:', { contentPath, variation, mboxName });

  block.innerHTML = '';

  const isAuthor = isAuthorEnvironment();
  const hostnameFromPlaceholders = await getHostname();
  const hostname = hostnameFromPlaceholders || getMetadata('hostname');
  const aemAuthorUrl = getMetadata('authorurl') || '';
  const aemPublishUrl = hostname?.replace('author', 'publish')?.replace(/\/$/, '') || '';

  log('Environment:', { isAuthor, hostname, aemAuthorUrl, aemPublishUrl });

  if (!contentPath) {
    logWarn('No content path configured');
    if (isAuthor) {
      block.innerHTML = `<div class="promotion-card promotion-placeholder">
        <div class="promotion-content">
          <p class="promotion-subtitle">Adobe Target Personalization</p>
          <h3 class="promotion-title">Promotion Block</h3>
          <p class="promotion-description">Select a default Content Fragment using the block properties panel. At runtime, Adobe Target may replace it with a personalized offer (mbox: <strong>${mboxName}</strong>).</p>
        </div>
      </div>`;
    }
    return;
  }

  try {
    const cfItem = await fetchContentFragment(contentPath, variation, isAuthor, aemAuthorUrl, aemPublishUrl);

    if (cfItem) {
      await renderCard(block, cfItem, isAuthor, 'default-CF');
    } else {
      logWarn('Default CF returned null – block will be empty unless Target provides an offer');
    }

    log('Starting background Target fetch...');
    fetchTargetOffer(mboxName).then(async (targetItem) => {
      if (targetItem) {
        log('🎯 Target returned a personalised offer – swapping card');
        await renderCard(block, targetItem, false, 'target-personalised');
        block.classList.add('promotion-personalised');
        log('Card swap complete ✓');
      } else {
        log('No Target offer – keeping default CF');
      }
    }).catch((err) => {
      logWarn('Target personalisation failed, keeping default CF:', err);
    });
  } catch (err) {
    logError('Block decoration failed:', err);
    block.innerHTML = '';
  }
}

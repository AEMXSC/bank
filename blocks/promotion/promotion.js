import { getMetadata } from '../../scripts/aem.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';
import { getHostname, mapAemPathToSitePath } from '../../scripts/utils.js';

/* ────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────── */

const TARGET_TENANT = 'aemdevlabs8';
const TARGET_CLIENT_CODE = 'aemdevlabs8';
const DEFAULT_MBOX = 'global';

const CF_CONFIG = {
  WRAPPER_SERVICE_URL: 'https://3635370-refdemoapigateway-stage.adobeioruntime.net/api/v1/web/ref-demo-api-gateway/fetch-cf',
  GRAPHQL_QUERY: '/graphql/execute.json/ref-demo-eds/CTAByPath',
};

/* ────────────────────────────────────────────
 * Target helpers
 * ──────────────────────────────────────────── */

function getTargetSessionId() {
  let id = sessionStorage.getItem('target_session_id');
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    sessionStorage.setItem('target_session_id', id);
  }
  return id;
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
  return params;
}

/* ────────────────────────────────────────────
 * Parsers – normalise both "exported CF" and
 * "flat offer" JSON shapes from Target
 * (mirrors the mobile app's TargetService)
 * ──────────────────────────────────────────── */

function normaliseOfferToCfShape(data) {
  const item = data?.data?.ctaByPath?.item;
  if (item) return item;

  return {
    title: data?.offer || data?.title || '',
    subtitle: data?.subtitle || '',
    description: data?.description ? { plaintext: data.description } : null,
    bannerimage: data?.bannerimage ? { _publishUrl: data.bannerimage } : null,
    ctalabel: data?.ctalabel || '',
    ctaurl: data?.ctaurl || null,
  };
}

/* ────────────────────────────────────────────
 * Content Fragment fetch (reuses the same
 * GraphQL + API-gateway pattern from the
 * content-fragment block)
 * ──────────────────────────────────────────── */

async function fetchContentFragment(contentPath, variation, isAuthor, aemAuthorUrl, aemPublishUrl) {
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

  const res = await fetch(requestConfig.url, {
    method: requestConfig.method,
    headers: requestConfig.headers,
    ...(requestConfig.body && { body: requestConfig.body }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json?.data?.ctaByPath?.item || null;
}

/* ────────────────────────────────────────────
 * Target offer fetch – at.js first, REST fallback
 * ──────────────────────────────────────────── */

function fetchViaAtJs(mbox, profileParams) {
  const target = window.adobe?.target;
  if (!target?.getOffer) return null;

  return new Promise((resolve) => {
    target.getOffer({
      mbox,
      params: profileParams,
      success(response) {
        try {
          const action = Array.isArray(response) ? response[0] : response;
          const raw = action?.content?.[0] ?? action?.content ?? action;
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          resolve(parsed);
        } catch { resolve(null); }
      },
      error() { resolve(null); },
      timeout: 5000,
    });
  });
}

async function fetchViaRestApi(mbox, profileParams) {
  const sessionId = getTargetSessionId();
  const url = `https://${TARGET_TENANT}.tt.omtrdc.net/rest/v1/mbox/${sessionId}?client=${TARGET_CLIENT_CODE}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mbox, mboxParameters: profileParams }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  const content = json?.content;
  if (!content) return null;
  return JSON.parse(content);
}

async function fetchTargetOffer(mbox, profileParams) {
  let raw = await fetchViaAtJs(mbox, profileParams);
  if (!raw) raw = await fetchViaRestApi(mbox, profileParams);
  if (!raw) return null;
  return normaliseOfferToCfShape(raw);
}

/* ────────────────────────────────────────────
 * Render a promotion card from CF-shaped data
 * ──────────────────────────────────────────── */

async function renderCard(block, cfItem, isAuthor) {
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
}

/* ────────────────────────────────────────────
 * Block decorator
 * ──────────────────────────────────────────── */

export default async function decorate(block) {
  const contentPath = block.querySelector(':scope div:nth-child(1) > div a')?.textContent?.trim()
    || block.querySelector(':scope div:nth-child(1) > div')?.textContent?.trim();
  const variation = block.querySelector(':scope div:nth-child(2) > div')?.textContent?.trim()?.toLowerCase()?.replace(' ', '_') || 'master';
  const mboxName = block.querySelector(':scope div:nth-child(3) > div')?.textContent?.trim() || DEFAULT_MBOX;

  block.innerHTML = '';

  const isAuthor = isAuthorEnvironment();
  const hostnameFromPlaceholders = await getHostname();
  const hostname = hostnameFromPlaceholders || getMetadata('hostname');
  const aemAuthorUrl = getMetadata('authorurl') || '';
  const aemPublishUrl = hostname?.replace('author', 'publish')?.replace(/\/$/, '') || '';

  if (!contentPath) {
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

  const spinner = document.createElement('div');
  spinner.className = 'promotion-loading';
  block.appendChild(spinner);

  try {
    if (isAuthor) {
      const cfItem = await fetchContentFragment(contentPath, variation, true, aemAuthorUrl, aemPublishUrl);
      if (cfItem) {
        await renderCard(block, cfItem, true);
      } else {
        block.innerHTML = '';
      }
      return;
    }

    const profileParams = getProfileParameters();
    const [cfItem, targetItem] = await Promise.all([
      fetchContentFragment(contentPath, variation, false, aemAuthorUrl, aemPublishUrl),
      fetchTargetOffer(mboxName, profileParams).catch(() => null),
    ]);

    const displayItem = targetItem || cfItem;
    if (displayItem) {
      await renderCard(block, displayItem, false);
    } else {
      block.innerHTML = '';
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Promotion block: error', err);
    block.innerHTML = '';
  }
}

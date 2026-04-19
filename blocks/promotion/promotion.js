import { isAuthorEnvironment } from '../../scripts/scripts.js';
import { mapAemPathToSitePath } from '../../scripts/utils.js';

const TARGET_TENANT = 'aemdevlabs8';
const TARGET_CLIENT_CODE = 'aemdevlabs8';
const DEFAULT_MBOX = 'global';

function getTargetSessionId() {
  let sessionId = sessionStorage.getItem('target_session_id');
  if (!sessionId) {
    sessionId = crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    sessionStorage.setItem('target_session_id', sessionId);
  }
  return sessionId;
}

/**
 * Collect visitor profile parameters from available sources:
 * 1. localStorage "userProfile" (mirrors SharedPreferences in the mobile app)
 * 2. Query-string parameters prefixed with "profile." (handy for demos)
 */
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
 * Parsers – handle both "exported CF" and "flat offer" JSON shapes
 * exactly like the mobile app's TargetService
 * ──────────────────────────────────────────── */

function parseBannerUrl(data) {
  return data?.data?.ctaByPath?.item?.bannerimage?._publishUrl
    || data?.bannerimage
    || '';
}

function parseTitle(data) {
  return data?.data?.ctaByPath?.item?.title
    || data?.offer
    || data?.title
    || '';
}

function parseSubtitle(data) {
  return data?.data?.ctaByPath?.item?.subtitle
    || data?.subtitle
    || '';
}

function parseDescription(data) {
  return data?.data?.ctaByPath?.item?.description?.plaintext
    || data?.description
    || '';
}

function parseCtaLabel(data) {
  return data?.data?.ctaByPath?.item?.ctalabel
    || data?.ctalabel
    || '';
}

function parseCtaUrl(data) {
  const cta = data?.data?.ctaByPath?.item?.ctaurl;
  if (cta) {
    if (typeof cta === 'string') return cta;
    return cta._publishUrl || cta._path || '#';
  }
  return data?.ctaurl || '#';
}

/* ────────────────────────────────────────────
 * Target API callers
 * ──────────────────────────────────────────── */

/**
 * Primary path – leverage at.js getOffer() when available (loaded via delayed.js).
 * Returns the parsed content JSON, or null if at.js is not ready.
 */
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
        } catch {
          resolve(null);
        }
      },
      error() {
        resolve(null);
      },
      timeout: 5000,
    });
  });
}

/**
 * Fallback – direct REST call to the Target v1 mbox endpoint,
 * mirroring the mobile app's TargetService.sendProfileToTarget().
 */
async function fetchViaRestApi(mbox, profileParams, tenant, clientCode) {
  const sessionId = getTargetSessionId();
  const url = `https://${tenant}.tt.omtrdc.net/rest/v1/mbox/${sessionId}?client=${clientCode}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mbox, mboxParameters: profileParams }),
  });

  if (!res.ok) return null;

  const json = await res.json();
  const contentStr = json?.content;
  if (!contentStr) return null;
  return JSON.parse(contentStr);
}

/* ────────────────────────────────────────────
 * DOM rendering
 * ──────────────────────────────────────────── */

async function renderCard(block, contentData) {
  const bannerUrl = parseBannerUrl(contentData);
  const title = parseTitle(contentData);
  const subtitle = parseSubtitle(contentData);
  const description = parseDescription(contentData);
  const ctaLabel = parseCtaLabel(contentData) || 'Learn More';
  let ctaHref = parseCtaUrl(contentData);

  if (ctaHref && ctaHref.startsWith('/content/')) {
    try {
      const mapped = await mapAemPathToSitePath(ctaHref);
      if (mapped) ctaHref = mapped;
    } catch { /* keep original */ }
  }

  const card = document.createElement('div');
  card.className = 'promotion-card';

  if (bannerUrl) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'promotion-image';
    const img = document.createElement('img');
    img.src = bannerUrl;
    img.alt = title || 'Promotion';
    img.loading = 'lazy';
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
  }

  const content = document.createElement('div');
  content.className = 'promotion-content';

  if (title) {
    const h3 = document.createElement('h3');
    h3.className = 'promotion-title';
    h3.textContent = title;
    content.appendChild(h3);
  }

  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'promotion-subtitle';
    sub.textContent = subtitle;
    content.appendChild(sub);
  }

  if (description) {
    const desc = document.createElement('p');
    desc.className = 'promotion-description';
    desc.textContent = description;
    content.appendChild(desc);
  }

  if (ctaLabel) {
    const ctaWrap = document.createElement('div');
    ctaWrap.className = 'promotion-cta';
    const anchor = document.createElement('a');
    anchor.href = ctaHref;
    anchor.className = 'button';
    anchor.textContent = ctaLabel;
    if (ctaHref.startsWith('http')) {
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
  const mboxName = block.querySelector(':scope div:nth-child(1) > div')?.textContent?.trim() || DEFAULT_MBOX;

  block.innerHTML = '';

  if (isAuthorEnvironment()) {
    block.innerHTML = `<div class="promotion-card promotion-placeholder">
      <div class="promotion-content">
        <p class="promotion-subtitle">Adobe Target Personalization</p>
        <h3 class="promotion-title">Promotion Block</h3>
        <p class="promotion-description">This block fetches a personalized offer from Adobe Target (mbox: <strong>${mboxName}</strong>) and renders it as a promotional card at runtime.</p>
      </div>
    </div>`;
    return;
  }

  const spinner = document.createElement('div');
  spinner.className = 'promotion-loading';
  block.appendChild(spinner);

  const profileParams = getProfileParameters();

  try {
    let contentData = await fetchViaAtJs(mboxName, profileParams);

    if (!contentData) {
      contentData = await fetchViaRestApi(mboxName, profileParams, TARGET_TENANT, TARGET_CLIENT_CODE);
    }

    if (!contentData) {
      // eslint-disable-next-line no-console
      console.info('Promotion block: no offer returned from Target for mbox', mboxName);
      block.innerHTML = '';
      return;
    }

    await renderCard(block, contentData);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Promotion block: error fetching Target offer', err);
    block.innerHTML = '';
  }
}

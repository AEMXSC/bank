import { loadScript } from '../../scripts/aem.js';

const DM_VIDEO_VIEWER_URL = 'https://delivery-p153659-e1620914.adobeaemcloud.com/adobe/assets/urn:aaid:aem:dmviewers-html5/as/DMVideoViewer.js';
let dmViewerPromise;
/**
 * Wait for the DM VideoViewer to be available on window.dmviewers
 * @param {number} timeout - Maximum time to wait in ms
 * @returns {Promise<boolean>} - Resolves to true when available, rejects on timeout
 */
function waitForDMViewer(timeout = 10000) {
  return new Promise((resolve, reject) => {
    // Check if already available
    if (window.dmviewers?.VideoViewer) {
      resolve(true);
      return;
    }

    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (window.dmviewers?.VideoViewer) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        reject(new Error('DM VideoViewer failed to load within timeout'));
      }
    }, 100);
  });
}

/**
 * Load the DM Video Viewer script and wait for it to be ready
 * @returns {Promise<void>}
 */
async function loadDMVideoViewer() {
  if (!dmViewerPromise) {
    dmViewerPromise = (async () => {
      // Load the script (will skip if already in DOM)
      await loadScript(DM_VIDEO_VIEWER_URL);
      // Wait for the viewer to be available on window
      await waitForDMViewer();
    })();
  }
  return dmViewerPromise;
}

/**
 * Decorate the dm-video block.
 * @param {Element} block The block root element.
 */
export default async function decorate(block) {
  try {
    await loadDMVideoViewer();
  } catch (error) {
    console.error('Failed to load DM VideoViewer:', error);
    return;
  }

  if (!window.dmviewers?.VideoViewer) {
    console.error('DM VideoViewer not available on window.dmviewers');
    return;
  }

  const videolinks = block.querySelectorAll('a[href]');
  //https://delivery-p153659-e1620914.adobeaemcloud.com/adobe/assets/urn:aaid:aem:20bd71c3-a5a1-4b9e-833e-42e5cd028c3c/renditions/original/as/SampleVideo1mb.mp4?assetname=SampleVideo1mb.mp4

  if(videolinks.length != 0){
    let videoUrl = videolinks[0].href;

    const urnPattern = /(\/adobe\/assets\/urn:[^\/]+)/i;
    const match = videoUrl.match(urnPattern);

    if (!match) {
      console.error('Invalid Dynamic Media video URL format');
      return null;
    }

    // Extract the base URL (protocol + hostname)
    const videoURLObj = new URL(videoUrl);
    const baseUrl = `${videoURLObj.protocol}//${videoURLObj.hostname}`;

    // Extract the asset ID path (e.g., /adobe/assets/urn:aaid:aem:20bd71c3-a5a1-4b9e-833e-42e5cd028c3c)
    const assetIdPath = match[1];

    // Construct the URLs
    const posterImageUrl = `${baseUrl}${assetIdPath}/as/thumbnail.jpeg?preferwebp=true`;
    const dashUrl = `${baseUrl}${assetIdPath}/manifest.mpd`;
    const hlsUrl = `${baseUrl}${assetIdPath}/manifest.m3u8`;

    // Create a container for the DM viewer
   // const playerContainer = block.querySelector('.dynamic-media-video');


    
    block.id = `dm-video-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    const params = {
      posterimage: posterImageUrl,
      sources: {},
    };

    if (dashUrl) params.sources.DASH = dashUrl;
    if (hlsUrl) params.sources.HLS = hlsUrl;

    let autoplay = '';
	  let loop = '';
	  let muted = '';
	  let showControls = '';
    
    const children = Array.from(block.children);
    // Helper function to safely extract text content from a child div
    const getTextFromChild = (index) => {
      const childDiv = children[index];
      if (!childDiv) return '';
      const pElement = childDiv.querySelector('p');
      return pElement?.textContent?.trim() || '';
    };

    autoplay = getTextFromChild(1)?.toLowerCase() === 'true' ? true : false ;
    loop = getTextFromChild(2)?.toLowerCase() === 'true' ? true : false;
    muted = getTextFromChild(3)?.toLowerCase() === 'true' ? true : false;

    Array.from(block.children).forEach((child) => {
				child.style.display = 'none';
		});

    if (autoplay) {
      params.autoplay = '1';
    }
    if (loop) {
      params.loop = '1';
    }
    if (muted) {
      params.muted = '1';  // or params.playback = 'muted';
    }

    // Controls behavior depends on the viewer version; simplest pattern:
    /*
    if (!showControls) {
      params.hidecontrolbar = '1';
    }
    */

    // Instantiate viewer
    const s7videoviewer = new window.dmviewers.VideoViewer({
      containerId: block.id,
      params,
    });
    s7videoviewer.init();
  } else{
     Array.from(block.children).forEach((child) => {
      child.style.display = 'none';
    });
  }
}

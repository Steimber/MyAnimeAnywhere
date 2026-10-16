const fs = require('fs');
const path = require('path');

const DEFAULT_HEADERS = {
  'User-Agent': 'MyAnimeAnywhere/1.0 (Node.js; +https://github.com/Steimber/MyAnimeAnywhere)',
  'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, video/mp2t, */*'
};

/**
 * Resolves relative segment or variant URLs against a base playlist URL.
 * @param {string} baseUrl
 * @param {string} targetUrl
 * @returns {string}
 */
function resolveUrl(baseUrl, targetUrl) {
  if (/^https?:\/\//i.test(targetUrl)) {
    return targetUrl;
  }
  return new URL(targetUrl, baseUrl).toString();
}

/**
 * Parses an HLS (.m3u8) manifest into either variant streams (Master Playlist)
 * or media segment URLs (Media Playlist).
 * @param {string} manifestText
 * @param {string} manifestUrl
 * @returns {{ type: 'master' | 'media', variants: Array<{bandwidth: number, resolution?: string, url: string}>, segments: string[] }}
 */
function parseM3u8Manifest(manifestText, manifestUrl) {
  const lines = manifestText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const variants = [];
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const resolution = resMatch ? resMatch[1] : undefined;

      // Next non-comment line is the variant URI
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) {
        j++;
      }
      if (j < lines.length) {
        variants.push({
          bandwidth,
          resolution,
          url: resolveUrl(manifestUrl, lines[j])
        });
        i = j;
      }
    } else if (!line.startsWith('#')) {
      segments.push(resolveUrl(manifestUrl, line));
    }
  }

  if (variants.length > 0) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: 'master', variants, segments: [] };
  }

  return { type: 'media', variants: [], segments };
}

/**
 * Fetches a buffer with exponential backoff retry logic.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Buffer>}
 */
async function fetchWithRetry(url, { headers = DEFAULT_HEADERS, retries = 3, baseDelayMs = 600, fetchImpl = fetch } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${response.statusText})`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)));
    }
  }
}

/**
 * Downloads an array of segment URLs concurrently while guaranteeing
 * strict in-order sequential writes to the destination stream.
 * @param {string[]} segments
 * @param {import('stream').Writable} writableStream
 * @param {object} options
 * @returns {Promise<{ totalSegments: number, totalBytes: number, elapsedMs: number }>}
 */
async function downloadSegmentsOrdered(
  segments,
  writableStream,
  {
    concurrency = 12,
    retries = 3,
    headers = DEFAULT_HEADERS,
    fetchImpl = fetch,
    onProgress = null
  } = {}
) {
  const total = segments.length;
  if (total === 0) {
    throw new Error('No media segments found in the playlist.');
  }

  const startTime = Date.now();
  const downloadedChunks = new Map();
  let nextToWrite = 0;
  let activeWorkers = 0;
  let completedCount = 0;
  let currentIndex = 0;
  let totalBytes = 0;
  let aborted = false;

  return new Promise((resolve, reject) => {
    function enqueueNext() {
      if (aborted) return;

      while (activeWorkers < concurrency && currentIndex < total) {
        const segmentIndex = currentIndex++;
        activeWorkers++;

        fetchWithRetry(segments[segmentIndex], { headers, retries, fetchImpl })
          .then(buffer => {
            if (aborted) return;
            activeWorkers--;
            completedCount++;
            totalBytes += buffer.length;
            downloadedChunks.set(segmentIndex, buffer);

            // Flush contiguous segments in strict order
            while (downloadedChunks.has(nextToWrite)) {
              const chunk = downloadedChunks.get(nextToWrite);
              downloadedChunks.delete(nextToWrite);
              writableStream.write(chunk);
              nextToWrite++;
            }

            if (typeof onProgress === 'function') {
              onProgress({
                completed: completedCount,
                total,
                totalBytes,
                elapsedMs: Date.now() - startTime
              });
            }

            if (completedCount === total) {
              writableStream.end(() => {
                resolve({
                  totalSegments: total,
                  totalBytes,
                  elapsedMs: Date.now() - startTime
                });
              });
            } else {
              enqueueNext();
            }
          })
          .catch(err => {
            if (aborted) return;
            aborted = true;
            writableStream.destroy();
            reject(new Error(`Segment #${segmentIndex} failed: ${err.message}`));
          });
      }
    }

    enqueueNext();
  });
}

/**
 * Resolves a Master or Media M3U8 URL and downloads the complete stream to a file.
 * @param {object} config
 */
async function downloadHlsStream({
  manifestUrl,
  outputPath,
  concurrency = 12,
  retries = 3,
  headers = DEFAULT_HEADERS,
  fetchImpl = fetch,
  onProgress = null,
  onManifestResolved = null
}) {
  const initialBuf = await fetchWithRetry(manifestUrl, { headers, retries, fetchImpl });
  const initialParsed = parseM3u8Manifest(initialBuf.toString('utf8'), manifestUrl);

  let activeManifestUrl = manifestUrl;
  let segments = initialParsed.segments;
  let selectedVariant = null;

  if (initialParsed.type === 'master') {
    selectedVariant = initialParsed.variants[0];
    activeManifestUrl = selectedVariant.url;
    const mediaBuf = await fetchWithRetry(activeManifestUrl, { headers, retries, fetchImpl });
    const mediaParsed = parseM3u8Manifest(mediaBuf.toString('utf8'), activeManifestUrl);
    segments = mediaParsed.segments;
  }

  if (typeof onManifestResolved === 'function') {
    onManifestResolved({
      manifestUrl: activeManifestUrl,
      selectedVariant,
      segmentCount: segments.length
    });
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const fileStream = fs.createWriteStream(outputPath);
  return downloadSegmentsOrdered(segments, fileStream, {
    concurrency,
    retries,
    headers,
    fetchImpl,
    onProgress
  });
}

module.exports = {
  DEFAULT_HEADERS,
  resolveUrl,
  parseM3u8Manifest,
  fetchWithRetry,
  downloadSegmentsOrdered,
  downloadHlsStream
};

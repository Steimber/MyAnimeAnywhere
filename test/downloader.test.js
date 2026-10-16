const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { parseM3u8Manifest, downloadSegmentsOrdered } = require('../src/downloader');

test('parseM3u8Manifest parses Master Playlist and sorts variants by highest bandwidth first', () => {
  const masterM3u8 = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720
mid/index.m3u8
  `.trim();

  const parsed = parseM3u8Manifest(masterM3u8, 'https://cdn.example.com/streams/master.m3u8');
  assert.equal(parsed.type, 'master');
  assert.equal(parsed.variants.length, 3);
  assert.equal(parsed.variants[0].resolution, '1920x1080');
  assert.equal(parsed.variants[0].url, 'https://cdn.example.com/streams/high/index.m3u8');
});

test('parseM3u8Manifest resolves relative and absolute segment URLs in Media Playlist', () => {
  const mediaM3u8 = `
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.000,
seg-001.ts
#EXTINF:4.000,
https://cdn.example.com/override/seg-002.ts
#EXT-X-ENDLIST
  `.trim();

  const parsed = parseM3u8Manifest(mediaM3u8, 'https://cdn.example.com/vod/ep1/playlist.m3u8');
  assert.equal(parsed.type, 'media');
  assert.deepEqual(parsed.segments, [
    'https://cdn.example.com/vod/ep1/seg-001.ts',
    'https://cdn.example.com/override/seg-002.ts'
  ]);
});

test('downloadSegmentsOrdered flushes segments in strict sequential order despite out-of-order completion', async () => {
  const segments = [
    'https://cdn.example.com/0.ts',
    'https://cdn.example.com/1.ts',
    'https://cdn.example.com/2.ts',
    'https://cdn.example.com/3.ts'
  ];

  // Simulate out-of-order network latency: segment 0 finishes last
  const delays = [60, 10, 25, 5];
  const fakeFetch = async url => {
    const idx = segments.indexOf(url);
    await new Promise(r => setTimeout(r, delays[idx]));
    return {
      ok: true,
      arrayBuffer: async () => Buffer.from(`CHUNK_${idx}|`)
    };
  };

  const outStream = new PassThrough();
  const received = [];
  outStream.on('data', chunk => received.push(chunk));

  const stats = await downloadSegmentsOrdered(segments, outStream, {
    concurrency: 4,
    fetchImpl: fakeFetch
  });

  assert.equal(stats.totalSegments, 4);
  const combined = Buffer.concat(received).toString('utf8');
  assert.equal(combined, 'CHUNK_0|CHUNK_1|CHUNK_2|CHUNK_3|');
});

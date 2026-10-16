#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { downloadHlsStream, DEFAULT_HEADERS } = require('./downloader');

function parseArgs(argv) {
  const args = {
    url: null,
    series: null,
    episode: null,
    out: null,
    concurrency: 12,
    retries: 3,
    referer: null,
    help: false
  };

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--url' || token === '-u') {
      args.url = argv[++i];
    } else if (token === '--series' || token === '-s') {
      args.series = argv[++i];
    } else if (token === '--episode' || token === '-e') {
      args.episode = parseInt(argv[++i], 10);
    } else if (token === '--out' || token === '-o') {
      args.out = argv[++i];
    } else if (token === '--concurrency' || token === '-c') {
      args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 12);
    } else if (token === '--retries' || token === '-r') {
      args.retries = Math.max(1, parseInt(argv[++i], 10) || 3);
    } else if (token === '--referer') {
      args.referer = argv[++i];
    } else if (!args.url && /^https?:\/\//i.test(token)) {
      args.url = token;
    }
  }

  return args;
}

function loadLocalConfig() {
  const configPath = path.join(process.cwd(), '.hlsrc.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderProgressBar({ completed, total, totalBytes, elapsedMs }) {
  const width = 28;
  const ratio = Math.min(1, completed / total);
  const filled = Math.round(width * ratio);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (ratio * 100).toFixed(1).padStart(5, ' ');
  const elapsedSec = Math.max(0.1, elapsedMs / 1000);
  const mbps = (totalBytes / (1024 * 1024) / elapsedSec).toFixed(2);
  process.stdout.write(
    `\r  [${bar}] ${pct}% | ${completed}/${total} segs | ${formatBytes(totalBytes)} (${mbps} MB/s)`
  );
}

function printHelp() {
  console.log(`
  HLS Concurrent Stream Downloader (RFC 8216)
  -------------------------------------------
  Downloads and assembles segmented HTTP Live Streaming (.m3u8) episodes
  using a bounded worker pool and sequential in-order buffer flushing.

  Usage:
    node src/cli.js --url <manifest.m3u8> [options]
    node src/cli.js --series <slug> --episode <number> [options]

  Options:
    -u, --url <url>          Direct HLS (.m3u8) Master or Media playlist URL
    -s, --series <slug>      Series identifier (resolved via local .hlsrc.json template)
    -e, --episode <num>      Episode number for output naming and template resolution
    -o, --out <path>         Output file path (default: downloads/<series>_ep<XX>.mp4)
    -c, --concurrency <n>    Parallel segment workers (default: 12)
    -r, --retries <n>        Max retries per segment with exponential backoff (default: 3)
    --referer <url>          Optional HTTP Referer header for authorized origin checks
    -h, --help               Show this help message
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const localCfg = loadLocalConfig();
  let manifestUrl = args.url;

  if (!manifestUrl && args.series && localCfg.urlTemplate) {
    const ep = args.episode || 1;
    manifestUrl = localCfg.urlTemplate
      .replace('{series}', args.series)
      .replace('{episode}', String(ep));
  }

  if (!manifestUrl) {
    printHelp();
    process.exit(1);
  }

  const epSuffix = args.episode ? `_ep${String(args.episode).padStart(2, '0')}` : '';
  const baseName = args.series
    ? `${args.series.replace(/[^a-zA-Z0-9_-]/g, '_')}${epSuffix}.mp4`
    : `stream${epSuffix || '_' + Date.now()}.mp4`;

  const outputPath = args.out
    ? path.resolve(args.out)
    : path.join(process.cwd(), 'downloads', baseName);

  const headers = { ...DEFAULT_HEADERS, ...(localCfg.headers || {}) };
  if (args.referer) {
    headers['Referer'] = args.referer;
  }

  console.log(`\n▶ Starting HLS Concurrent Stream Downloader`);
  console.log(`  • Workers     : ${args.concurrency} parallel streams`);
  console.log(`  • Output      : ${outputPath}`);

  const result = await downloadHlsStream({
    manifestUrl,
    outputPath,
    concurrency: args.concurrency,
    retries: args.retries,
    headers,
    onManifestResolved: ({ selectedVariant, segmentCount }) => {
      if (selectedVariant) {
        console.log(
          `  • Variant     : ${selectedVariant.resolution || 'Best quality'} (${Math.round(
            selectedVariant.bandwidth / 1000
          )} kbps)`
        );
      }
      console.log(`  • Segments    : ${segmentCount} chunks queued\n`);
    },
    onProgress: renderProgressBar
  });

  process.stdout.write('\n\n');
  console.log(`✓ Download complete in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  • Total size  : ${formatBytes(result.totalBytes)}`);
  console.log(`  • Saved file  : ${outputPath}\n`);
}

if (require.main === module) {
  main().catch(err => {
    process.stdout.write('\n');
    console.error(`✖ Error: ${err.message}`);
    process.exit(1);
  });
}

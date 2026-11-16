// visual.mjs — Zero-dependency PNG codec & perceptual pixel-diff visual regression,
// page PDF generator, and jailed download artifact inspector (SHA-256 + structured preview).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_PIXELS = 16_000_000; // 16 MP safety ceiling (~64 MB RGBA)
export const MAX_BASELINES_PER_SESSION = 16;
const SENSITIVE_PREVIEW_RE = /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|authorization)\s*[:=]\s*)([^\s,"'&;]+)/gi;

// ---------- IEEE 802.3 CRC32 for PNG chunk synthesis ----------
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(typeBuf, dataBuf) {
  let c = 0xffffffff;
  for (let i = 0; i < typeBuf.length; i++) c = CRC_TABLE[(c ^ typeBuf[i]) & 0xff] ^ (c >>> 8);
  for (let i = 0; i < dataBuf.length; i++) c = CRC_TABLE[(c ^ dataBuf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(typeBuf, data), 8 + data.length);
  return out;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------- Zero-dependency PNG decoder (8-bit Gray, RGB, Palette, Gray+A, RGBA) ----------
export function decodePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatParts = [];

  let offset = 8;
  while (offset + 8 <= b.length) {
    const len = b.readUInt32BE(offset);
    const type = b.subarray(offset + 4, offset + 8).toString('ascii');
    const start = offset + 8;
    const end = start + len;
    if (end + 4 > b.length) throw new Error('truncated PNG chunk');
    const chunk = b.subarray(start, end);

    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      const compression = chunk[10];
      const filter = chunk[11];
      interlace = chunk[12];
      if (!width || !height || width * height > MAX_PNG_PIXELS) {
        throw new Error(`PNG dimensions out of range (${width}x${height})`);
      }
      if (compression !== 0 || filter !== 0) throw new Error('unsupported PNG compression/filter method');
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth: ${bitDepth} (expected 8-bit)`);
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      trns = chunk;
    } else if (type === 'IDAT') {
      idatParts.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (!width || !height || !idatParts.length) {
    throw new Error('incomplete PNG stream');
  }

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`unsupported PNG color type: ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('indexed PNG missing PLTE chunk');

  const bpp = channels;
  const stride = width * bpp;
  const expectedRaw = height * (1 + stride);
  const inflated = zlib.inflateSync(Buffer.concat(idatParts), { maxOutputLength: expectedRaw + 1024 });
  if (inflated.length < expectedRaw) throw new Error('decompressed PNG scanlines truncated');

  const curRow = new Uint8Array(stride);
  const prevRow = new Uint8Array(stride);
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    const filterType = inflated[rowStart];
    const dataStart = rowStart + 1;

    for (let i = 0; i < stride; i++) {
      const x = inflated[dataStart + i];
      const left = i >= bpp ? curRow[i - bpp] : 0;
      const up = prevRow[i];
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
      switch (filterType) {
        case 0: curRow[i] = x; break;
        case 1: curRow[i] = (x + left) & 0xff; break;
        case 2: curRow[i] = (x + up) & 0xff; break;
        case 3: curRow[i] = (x + ((left + up) >> 1)) & 0xff; break;
        case 4: curRow[i] = (x + paethPredictor(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`unknown PNG scanline filter: ${filterType}`);
      }
    }

    const dstBase = y * width * 4;
    if (colorType === 6) {
      rgba.set(curRow, dstBase);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = dstBase + x * 4;
        rgba[d] = curRow[s];
        rgba[d + 1] = curRow[s + 1];
        rgba[d + 2] = curRow[s + 2];
        rgba[d + 3] = 255;
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const g = curRow[x];
        const d = dstBase + x * 4;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const g = curRow[x * 2];
        const a = curRow[x * 2 + 1];
        const d = dstBase + x * 4;
        rgba[d] = g;
        rgba[d + 1] = g;
        rgba[d + 2] = g;
        rgba[d + 3] = a;
      }
    } else if (colorType === 3) {
      for (let x = 0; x < width; x++) {
        const idx = curRow[x];
        const p = idx * 3;
        const d = dstBase + x * 4;
        rgba[d] = palette[p] ?? 0;
        rgba[d + 1] = palette[p + 1] ?? 0;
        rgba[d + 2] = palette[p + 2] ?? 0;
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prevRow.set(curRow);
  }

  return { width, height, data: rgba };
}

// ---------- Zero-dependency 8-bit RGBA PNG encoder ----------
export function encodePng(width, height, rgbaData) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('encodePng requires positive integer width and height');
  }
  if (rgbaData.length !== width * height * 4) {
    throw new Error('RGBA buffer length mismatch');
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (1 + stride));
  // Use Sub filter (1) for compact screenshot/diff compression.
  for (let y = 0; y < height; y++) {
    const dstRow = y * (1 + stride);
    const srcRow = y * stride;
    raw[dstRow] = 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? rgbaData[srcRow + i - 4] : 0;
      raw[dstRow + 1 + i] = (rgbaData[srcRow + i] - left) & 0xff;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function readPngDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Perceptual YIQ color difference (Kotsarenko & Ramos, 2010), normalized to [0..35215].
function yiqDeltaSq(r1, g1, b1, a1, r2, g2, b2, a2) {
  if (r1 === r2 && g1 === g2 && b1 === b2 && a1 === a2) return 0;
  if (a1 < 255) {
    const k = a1 / 255;
    r1 = 255 + (r1 - 255) * k;
    g1 = 255 + (g1 - 255) * k;
    b1 = 255 + (b1 - 255) * k;
  }
  if (a2 < 255) {
    const k = a2 / 255;
    r2 = 255 + (r2 - 255) * k;
    g2 = 255 + (g2 - 255) * k;
    b2 = 255 + (b2 - 255) * k;
  }
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const i = dr * 0.59597799 - dg * 0.27417610 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

// ---------- Pixel-level visual regression comparator ----------
export function comparePngBuffers(baselineBuf, currentBuf, opts = {}) {
  const threshold = Number.isFinite(opts.threshold)
    ? Math.min(1, Math.max(0, Number(opts.threshold)))
    : 0.1;
  const maxDiffPercent = Number.isFinite(opts.maxDiffPercent)
    ? Math.min(100, Math.max(0, Number(opts.maxDiffPercent)))
    : 0.1;
  const includeDiffImage = opts.includeDiffImage !== false;

  const imgA = decodePng(baselineBuf);
  const imgB = decodePng(currentBuf);

  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);
  const sizeChanged = imgA.width !== imgB.width || imgA.height !== imgB.height;
  const totalPixels = width * height;
  const maxDelta = 35215 * threshold * threshold;

  const diffRgba = includeDiffImage ? new Uint8Array(totalPixels * 4) : null;
  // Coarse 8x8 grid hotspot tracker so agents know *where* the UI broke.
  const gridCols = 8;
  const gridRows = 8;
  const gridHits = new Uint32Array(gridCols * gridRows);
  const gridTotals = new Uint32Array(gridCols * gridRows);

  let diffPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const gy = Math.min(gridRows - 1, Math.floor((y * gridRows) / height));
    const inAY = y < imgA.height;
    const inBY = y < imgB.height;

    for (let x = 0; x < width; x++) {
      const gx = Math.min(gridCols - 1, Math.floor((x * gridCols) / width));
      const gIdx = gy * gridCols + gx;
      gridTotals[gIdx] += 1;

      const inA = inAY && x < imgA.width;
      const inB = inBY && x < imgB.width;
      const outIdx = (y * width + x) * 4;

      if (!inA || !inB) {
        // Size-mismatch overflow region — mark in amber
        diffPixels += 1;
        gridHits[gIdx] += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (diffRgba) {
          diffRgba[outIdx] = 255;
          diffRgba[outIdx + 1] = 179;
          diffRgba[outIdx + 2] = 0;
          diffRgba[outIdx + 3] = 255;
        }
        continue;
      }

      const idxA = (y * imgA.width + x) * 4;
      const idxB = (y * imgB.width + x) * 4;
      const r1 = imgA.data[idxA];
      const g1 = imgA.data[idxA + 1];
      const b1 = imgA.data[idxA + 2];
      const a1 = imgA.data[idxA + 3];
      const r2 = imgB.data[idxB];
      const g2 = imgB.data[idxB + 1];
      const b2 = imgB.data[idxB + 2];
      const a2 = imgB.data[idxB + 3];

      const delta = yiqDeltaSq(r1, g1, b1, a1, r2, g2, b2, a2);
      if (delta > maxDelta) {
        diffPixels += 1;
        gridHits[gIdx] += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (diffRgba) {
          diffRgba[outIdx] = 255;
          diffRgba[outIdx + 1] = 45;
          diffRgba[outIdx + 2] = 85;
          diffRgba[outIdx + 3] = 255;
        }
      } else if (diffRgba) {
        // Soft grayscale ghost of baseline so visual context stays legible
        const lum = Math.round(r1 * 0.299 + g1 * 0.587 + b1 * 0.114);
        const soft = Math.round(255 - (255 - lum) * 0.25);
        diffRgba[outIdx] = soft;
        diffRgba[outIdx + 1] = soft;
        diffRgba[outIdx + 2] = soft;
        diffRgba[outIdx + 3] = 255;
      }
    }
  }

  const hotspots = [];
  for (let gy = 0; gy < gridRows; gy++) {
    for (let gx = 0; gx < gridCols; gx++) {
      const idx = gy * gridCols + gx;
      if (gridHits[idx] === 0) continue;
      const cellW = Math.ceil(width / gridCols);
      const cellH = Math.ceil(height / gridRows);
      const x = gx * cellW;
      const y = gy * cellH;
      hotspots.push({
        x,
        y,
        width: Math.min(cellW, width - x),
        height: Math.min(cellH, height - y),
        diffPixels: gridHits[idx],
        cellDiffPercent: Math.round((gridHits[idx] / Math.max(1, gridTotals[idx])) * 10000) / 100,
      });
    }
  }
  hotspots.sort((a, b) => b.diffPixels - a.diffPixels);

  const diffRatio = totalPixels > 0 ? diffPixels / totalPixels : 0;
  const diffPercent = Math.round(diffRatio * 10000) / 100;
  const passed = !sizeChanged && diffPercent <= maxDiffPercent;
  const boundingBox = maxX >= minX
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;

  const result = {
    passed,
    matched: diffPixels === 0 && !sizeChanged,
    threshold,
    maxDiffPercent,
    width,
    height,
    sizeChanged,
    baselineSize: { width: imgA.width, height: imgA.height },
    currentSize: { width: imgB.width, height: imgB.height },
    totalPixels,
    diffPixels,
    diffRatio: Math.round(diffRatio * 1_000_000) / 1_000_000,
    diffPercent,
    boundingBox,
    hotspots: hotspots.slice(0, 8),
  };

  if (includeDiffImage && diffRgba) {
    const diffBuf = encodePng(width, height, diffRgba);
    result.mimeType = 'image/png';
    result.diffBytes = diffBuf.length;
    result.diffBase64 = diffBuf.toString('base64');
  }
  return result;
}

// ---------- PDF Generator ----------
const ALLOWED_PDF_FORMATS = new Set(['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
const CSS_LEN_RE = /^\d+(?:\.\d+)?(?:px|in|cm|mm)$/;

function sanitizeMargin(margin) {
  if (!margin || typeof margin !== 'object') return { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' };
  const out = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (margin[side] === undefined) continue;
    const v = String(margin[side]).trim();
    if (!CSS_LEN_RE.test(v)) throw new Error(`invalid margin.${side} (use px, mm, cm, or in, e.g. "12mm")`);
    out[side] = v;
  }
  return out;
}

export async function generatePagePdf(page, opts = {}) {
  if (typeof page?.pdf !== 'function') {
    throw new Error('PDF generation requires headless Chromium (page.pdf unavailable)');
  }
  const format = opts.format ? String(opts.format) : 'A4';
  if (!ALLOWED_PDF_FORMATS.has(format)) {
    throw new Error(`unsupported PDF paper format "${format}" (use A4, Letter, Legal, A3, A5, Tabloid)`);
  }
  const scale = opts.scale !== undefined ? Number(opts.scale) : 1;
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
    throw new Error('scale must be between 0.1 and 2');
  }
  const pdfOpts = {
    format,
    landscape: Boolean(opts.landscape),
    printBackground: opts.printBackground !== false,
    scale,
    margin: sanitizeMargin(opts.margin),
    ...(opts.pageRanges ? { pageRanges: String(opts.pageRanges).slice(0, 64) } : {}),
  };

  const buf = await page.pdf(pdfOpts);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const pageCount = estimatePdfPages(buf);

  let savedPath = null;
  if (opts.save && opts.downloadDir) {
    await fs.mkdir(opts.downloadDir, { recursive: true });
    const rootReal = await fs.realpath(opts.downloadDir);
    const base = String(opts.filename || 'page.pdf')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'page.pdf';
    const finalName = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
    const target = path.resolve(rootReal, `${Date.now()}-${finalName}`);
    const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (!target.startsWith(prefix)) throw new Error('PDF output path escapes download directory');
    await fs.writeFile(target, buf);
    savedPath = target;
  }

  const includeBase64 = opts.includeBase64 !== false && buf.length <= 8_000_000;
  return {
    mimeType: 'application/pdf',
    url: page.url?.() || '',
    title: (await page.title?.().catch(() => '')) || '',
    format,
    landscape: pdfOpts.landscape,
    bytes: buf.length,
    pageCount,
    sha256,
    savedPath,
    ...(includeBase64 ? { base64: buf.toString('base64') } : { base64Omitted: true }),
  };
}

function estimatePdfPages(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 2_000_000)).toString('latin1');
  const matches = sample.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

// ---------- Safe Download Artifact Inspector ----------
function parseDelimitedLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function redactPreviewText(text) {
  return String(text || '').replace(SENSITIVE_PREVIEW_RE, '$1[REDACTED]');
}

function detectArtifactKind(filename, buf) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.json') return 'json';
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.xml' || ext === '.svg') return 'xml';
  if (['.txt', '.log', '.yaml', '.yml', '.toml', '.ini'].includes(ext)) return 'text';

  // Sniff for binary NUL bytes in first 2 KB
  const head = buf.subarray(0, Math.min(buf.length, 2048));
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return 'binary';
  }
  return buf.length ? 'text' : 'empty';
}

export async function inspectDownloadArtifact(record, { downloadDir = '', maxChars = 4000, maxRows = 25 } = {}) {
  if (!record || typeof record !== 'object') throw new Error('download record not found');
  const filePath = record.savedPath || record.path || '';
  if (!filePath) {
    return {
      ...record,
      inspected: false,
      reason: 'file was not persisted (set AGENT_BROWSER_DOWNLOAD_DIR to persist downloads)',
    };
  }

  const realFile = await fs.realpath(filePath);
  if (downloadDir) {
    const rootReal = await fs.realpath(downloadDir);
    const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (!realFile.startsWith(prefix)) {
      throw new Error('download path escapes AGENT_BROWSER_DOWNLOAD_DIR');
    }
  }

  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error('download artifact is not a regular file');

  // Read up to 10 MB for hashing/preview so giant downloads never exhaust memory.
  const MAX_READ = 10 * 1024 * 1024;
  const fh = await fs.open(realFile, 'r');
  let buf;
  let fullHash = true;
  try {
    if (stat.size <= MAX_READ) {
      buf = Buffer.allocUnsafe(stat.size);
      await fh.read(buf, 0, stat.size, 0);
    } else {
      buf = Buffer.allocUnsafe(262_144);
      await fh.read(buf, 0, buf.length, 0);
      fullHash = false;
    }
  } finally {
    await fh.close();
  }

  let sha256;
  if (fullHash) {
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  } else {
    // Stream hash for large files
    const hash = crypto.createHash('sha256');
    const streamFh = await fs.open(realFile, 'r');
    try {
      const chunk = Buffer.allocUnsafe(65_536);
      let pos = 0;
      while (pos < stat.size) {
        const { bytesRead } = await streamFh.read(chunk, 0, chunk.length, pos);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead));
        pos += bytesRead;
      }
      sha256 = hash.digest('hex');
    } finally {
      await streamFh.close();
    }
  }

  const kind = detectArtifactKind(record.filename || realFile, buf);
  const safeMaxChars = Math.min(50_000, Math.max(100, Math.trunc(Number(maxChars) || 4000)));
  const safeMaxRows = Math.min(200, Math.max(1, Math.trunc(Number(maxRows) || 25)));

  const out = {
    id: record.id || null,
    filename: record.filename || path.basename(realFile),
    url: record.url || '',
    at: record.at || null,
    savedPath: realFile,
    bytes: stat.size,
    sha256,
    kind,
    inspected: true,
  };

  if (kind === 'csv' || kind === 'tsv') {
    const delim = kind === 'tsv' ? '\t' : ',';
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const headers = lines.length ? parseDelimitedLine(lines[0], delim) : [];
    const dataLines = lines.slice(1);
    const rows = dataLines.slice(0, safeMaxRows).map((line) => {
      const cells = parseDelimitedLine(line, delim);
      const obj = {};
      headers.forEach((h, i) => {
        const key = h || `col_${i + 1}`;
        const val = cells[i] ?? '';
        obj[key] = /password|secret|token|api[_-]?key/i.test(key) ? '[REDACTED]' : val.slice(0, 500);
      });
      return obj;
    });
    out.headers = headers;
    out.totalRows = dataLines.length;
    out.rowsTruncated = dataLines.length > safeMaxRows || !fullHash;
    out.rows = rows;
  } else if (kind === 'json') {
    const rawText = buf.toString('utf8');
    out.preview = redactPreviewText(rawText.slice(0, safeMaxChars));
    out.truncated = rawText.length > safeMaxChars || !fullHash;
    if (fullHash && stat.size <= 2_000_000) {
      try {
        const parsed = JSON.parse(rawText);
        if (Array.isArray(parsed)) {
          out.jsonType = 'array';
          out.itemCount = parsed.length;
          out.sample = parsed.slice(0, Math.min(10, safeMaxRows)).map(redactJsonValue);
        } else if (parsed && typeof parsed === 'object') {
          out.jsonType = 'object';
          out.keys = Object.keys(parsed).slice(0, 80);
        } else {
          out.jsonType = typeof parsed;
        }
      } catch {
        out.parseError = 'invalid JSON';
      }
    }
  } else if (kind === 'jsonl') {
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    out.totalLines = lines.length;
    out.sample = lines.slice(0, Math.min(10, safeMaxRows)).map((l) => {
      try { return redactJsonValue(JSON.parse(l)); } catch { return redactPreviewText(l.slice(0, 300)); }
    });
  } else if (kind === 'text' || kind === 'markdown' || kind === 'html' || kind === 'xml') {
    const rawText = buf.toString('utf8');
    out.preview = redactPreviewText(rawText.slice(0, safeMaxChars));
    out.truncated = rawText.length > safeMaxChars || !fullHash;
  } else if (kind === 'pdf') {
    out.pageCount = estimatePdfPages(buf);
  } else if (kind === 'png') {
    out.dimensions = readPngDimensions(buf);
  }

  return out;
}

function redactJsonValue(val, depth = 0) {
  if (depth > 5 || val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.slice(0, 25).map((v) => redactJsonValue(v, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val).slice(0, 50)) {
      out[k] = /password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key/i.test(k)
        ? '[REDACTED]'
        : redactJsonValue(v, depth + 1);
    }
    return out;
  }
  if (typeof val === 'string') return val.slice(0, 500);
  return val;
}

import * as zlib from 'node:zlib';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export class ZipError extends Error {
  constructor(message, code = 'ZIP') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

export function crc32(buf, start = 0, end = buf.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (readU32(buf, i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  throw new ZipError('Not a zip archive: missing end-of-central-directory record', 'ZIP_HEADER');
}

function readZip64Locator(eocdOffset, buf) {
  const locatorOffset = eocdOffset - 20;
  if (readU32(buf, locatorOffset) !== ZIP64_LOCATOR_SIG) {
    throw new ZipError('ZIP64 archive without a valid ZIP64 locator', 'ZIP64_LOCATOR');
  }
  const lo = buf.readUInt32LE(locatorOffset + 8);
  const hi = buf.readUInt32LE(locatorOffset + 12);
  const zip64Offset = lo + hi * 0x100000000;
  if (readU32(buf, zip64Offset) !== ZIP64_EOCD_SIG) {
    throw new ZipError('ZIP64 end-of-central-directory record not found', 'ZIP64_EOCD');
  }
  return {
    entriesTotal: Number(buf.readBigUInt64LE(zip64Offset + 32)),
    centralSize: Number(buf.readBigUInt64LE(zip64Offset + 48)),
    centralOffset: Number(buf.readBigUInt64LE(zip64Offset + 56)),
  };
}

function readCentralEntry(buf, offset) {
  if (readU32(buf, offset) !== CENTRAL_HEADER) {
    throw new ZipError('Corrupt zip: bad central-directory signature', 'ZIP_CENTRAL');
  }
  const flags = buf.readUInt16LE(offset + 8);
  const method = buf.readUInt16LE(offset + 10);
  const crc = readU32(buf, offset + 16);
  let compressedSize = readU32(buf, offset + 20);
  let uncompressedSize = readU32(buf, offset + 24);
  const nameLen = buf.readUInt16LE(offset + 28);
  const extraLen = buf.readUInt16LE(offset + 30);
  const commentLen = buf.readUInt16LE(offset + 32);
  const externalAttributes = readU32(buf, offset + 38);
  let localHeaderOffset = readU32(buf, offset + 42);
  const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
  const extra = buf.subarray(offset + 46 + nameLen, offset + 46 + nameLen + extraLen);
  const comment = buf.toString('utf8', offset + 46 + nameLen + extraLen, offset + 46 + nameLen + extraLen + commentLen);

  if (flags & 0x0001) {
    throw new ZipError(`Encrypted zip entries are not supported: ${name}`, 'ZIP_ENCRYPTED');
  }
  if (flags & 0x0040) {
    throw new ZipError('Deflate64 entries are not supported', 'ZIP_DEFLATE64');
  }

  let base = 0;
  while (base + 4 <= extra.length) {
    const id = extra.readUInt16LE(base);
    const size = extra.readUInt16LE(base + 2);
    if (id === ZIP64_EXTRA_ID) {
      const field = base + 4;
      let cursor = field;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (localHeaderOffset === 0xffffffff) {
        localHeaderOffset = Number(extra.readBigUInt64LE(cursor));
      }
      break;
    }
    base += 4 + size;
  }

  return {
    name,
    method,
    crc,
    flags,
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
    externalAttributes,
    nameLen,
    extraLen,
    commentLen,
    isDirectory: name.endsWith('/'),
  };
}

export function safeRelArchiveName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) return null;
  const normalized = name.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) return null;
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments[0] === '.') segments.shift();
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return null;
  }
  return segments.join('/');
}

export function parseZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new ZipError('parseZip expects a Buffer', 'ZIP_HEADER');
  const eocdOffset = findEndOfCentralDirectory(buf);
  let entriesTotal = buf.readUInt16LE(eocdOffset + 10);
  let centralSize = readU32(buf, eocdOffset + 12);
  let centralOffset = readU32(buf, eocdOffset + 16);
  if (entriesTotal === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const zip64 = readZip64Locator(eocdOffset, buf);
    entriesTotal = zip64.entriesTotal;
    centralSize = zip64.centralSize;
    centralOffset = zip64.centralOffset;
  }
  if (entriesTotal > 100_000) {
    throw new ZipError(`Refusing to process archive with ${entriesTotal} entries`, 'ZIP_TOO_MANY');
  }
  if (centralOffset + centralSize > buf.length) {
    throw new ZipError('Corrupt zip: central directory points outside the archive', 'ZIP_CENTRAL');
  }
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < entriesTotal; i += 1) {
    const entry = readCentralEntry(buf, cursor);
    entries.push({ ...entry, index: i });
    cursor += 46 + entry.nameLen + entry.extraLen + entry.commentLen;
  }
  return { entries, comment: buf.toString('utf8', eocdOffset + 22) };
}

export function readZipEntry(buf, entry) {
  if (entry.isDirectory) return Buffer.alloc(0);
  const localOffset = entry.localHeaderOffset;
  if (readU32(buf, localOffset) !== LOCAL_HEADER) {
    throw new ZipError(`Corrupt zip: bad local header for ${entry.name}`, 'ZIP_LOCAL');
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buf.length) {
    throw new ZipError(`Corrupt zip: entry ${entry.name} points outside the archive`, 'ZIP_LOCAL');
  }
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  let data;
  if (entry.method === METHOD_STORE) {
    data = Buffer.from(compressed);
  } else if (entry.method === METHOD_DEFLATE) {
    data = zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
  } else {
    throw new ZipError(`Unsupported compression method ${entry.method} for ${entry.name}`, 'ZIP_METHOD');
  }
  if (data.length !== entry.uncompressedSize) {
    throw new ZipError(`Size mismatch unpacking ${entry.name}`, 'ZIP_SIZE');
  }
  if (crc32(data) !== entry.crc) {
    throw new ZipError(`Checksum mismatch unpacking ${entry.name}`, 'ZIP_CRC');
  }
  return data;
}

export async function unzipToDisk(buf, destDir, onEntry) {
  const { entries } = parseZip(buf);
  const destRoot = path.resolve(destDir);
  const prefix = destRoot + path.sep;
  let files = 0;
  for (const entry of entries) {
    const safe = safeRelArchiveName(entry.name);
    if (safe === null) {
      throw new ZipError(`Unsafe archive path: ${entry.name}`, 'ZIP_TRAVERSAL');
    }
    const target = path.resolve(destRoot, safe);
    if (target !== destRoot && !target.startsWith(prefix)) {
      throw new ZipError(`Unsafe archive path: ${entry.name}`, 'ZIP_TRAVERSAL');
    }
    if (entry.isDirectory) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }
    const data = readZipEntry(buf, entry);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    if (onEntry) onEntry({ name: safe, size: data.length, entry });
    files += 1;
  }
  return files;
}

function dosDateTime(date = new Date()) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function buildZip(entries, options = {}) {
  const method = options.method ?? 'deflate';
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const isDirectory = entry.path.endsWith('/') || entry.data === undefined;
    const raw = isDirectory ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    const useDeflate = method === 'deflate';
    const data = useDeflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const entryMethod = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(raw);
    const { time, day } = dosDateTime(entry.when ? new Date(entry.when) : new Date());
    const nameBuf = Buffer.from(name, 'utf8');
    const mode = isDirectory ? 0x41ed0000 : (entry.mode ?? 0x81a40000);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entryMethod, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entryMethod, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(mode, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const centralSizeTotal = central.reduce((sum, b) => sum + b.length, 0);
  const centralOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSizeTotal, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const out = Buffer.concat([...chunks, ...central, eocd]);
  return out;
}

export function extractEntriesToJson(buf) {
  const { entries } = parseZip(buf);
  return entries.map((e) => ({
    name: e.name,
    method: e.method,
    size: e.uncompressedSize,
    compressedSize: e.compressedSize,
    crc: e.crc,
    isDirectory: e.isDirectory,
  }));
}
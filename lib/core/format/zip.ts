// A minimal zip writer for the support bundle (lib/engine/ops/bundle.ts): Forge has no runtime dependencies,
// and zlib gives deflate and CRC-32. Pure: it builds the archive in memory and never touches fs.
// No zip64, encryption or extra fields: the bundle's entries are capped far below those limits.
import zlib from 'node:zlib';
import { ForgeError } from '../errors.ts';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const VERSION = 20;
/** Made by Unix (3), so external attributes carry a mode: a plain 0644 file. */
const MADE_BY = (3 << 8) | VERSION;
const UTF8_FLAG = 0x0800;
const FILE_ATTRS = (0o100644 << 16) >>> 0;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

/** The MS-DOS time and date fields for a local time; the format starts in 1980 and counts seconds in twos. */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Why a name can't be an entry, or null: no `\`, which some extractors treat as a separator, no
 * control characters, and nothing that resolves outside the extraction dir.
 */
function unsafeEntryName(name: string): string | null {
  if (!name) return 'empty';
  if (name.includes('\\')) return 'a backslash';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'a control character';
  if (name.startsWith('/')) return 'a leading /';
  if (name.split('/').includes('..')) return 'a .. segment';
  return null;
}

function tooBig(what: string): never {
  throw new ForgeError(`the support bundle is too large for a zip without zip64 (${what})`);
}

/** A zip archive of the entries, each deflated when that is smaller and stored otherwise. */
export function zip(entries: ZipEntry[], date = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) tooBig(`${entries.length} entries`);
  const { time, date: day } = dosDateTime(date);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const unsafe = unsafeEntryName(e.name);
    if (unsafe) throw new ForgeError(`refusing a zip entry name with ${unsafe}: ${JSON.stringify(e.name.slice(0, 80))}`);
    const name = Buffer.from(e.name, 'utf8');
    if (name.length > 0xffff) tooBig(`a ${name.length}-byte name`);
    if (e.data.length >= MAX_SIZE) tooBig(`${e.name} is ${e.data.length} bytes`);
    const deflated = zlib.deflateRawSync(e.data);
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(e.data) >>> 0;
    if (offset >= MAX_SIZE) tooBig(`offset ${offset}`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(MADE_BY, 4);
    dir.writeUInt16LE(VERSION, 6);
    dir.writeUInt16LE(UTF8_FLAG, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number and internal attributes all stay 0.
    dir.writeUInt32LE(FILE_ATTRS, 38);
    dir.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  if (offset >= MAX_SIZE || cdSize >= MAX_SIZE || offset + cdSize >= MAX_SIZE) tooBig(`${offset + cdSize} bytes`);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

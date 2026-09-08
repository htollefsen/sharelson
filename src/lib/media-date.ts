import { File } from "expo-file-system";

import { toFileUri } from "@/lib/drive";

/**
 * Finds when a shared photo or video was originally taken, so Drive can be told the real
 * creation time instead of the upload time. Sources, in order:
 *   1. JPEG EXIF `DateTimeOriginal` (with `OffsetTimeOriginal` when present)
 *   2. MP4/MOV `mvhd` creation time
 *   3. A `YYYYMMDD_HHMMSS` timestamp in the file name (PXL_, IMG_, VID_ …)
 * Times without a zone are taken as the phone's local time, which is what cameras write.
 */

const HEADER_BYTES = 256 * 1024; // enough for the EXIF segment of any sane JPEG
const MAX_ATOM_SCAN = 64; // top-level / moov children to inspect before giving up

function plausible(date: Date): boolean {
  const year = date.getFullYear();
  return !Number.isNaN(date.getTime()) && year >= 1990 && year <= 2100;
}

/** "2026:09:08 15:55:28" (+ optional "+02:00") → Date. */
function parseExifDate(value: string, offset?: string): Date | null {
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = offset?.match(/^[+-]\d{2}:\d{2}$/)
    ? new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`)
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return plausible(date) ? date : null;
}

// ---------------------------------------------------------------------------------------------
// JPEG / EXIF

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function exifDate(head: Uint8Array): Date | null {
  if (head[0] !== 0xff || head[1] !== 0xd8) return null; // not a JPEG
  let pos = 2;
  while (pos + 4 <= head.length && head[pos] === 0xff) {
    const marker = head[pos + 1];
    const length = (head[pos + 2] << 8) | head[pos + 3];
    if (marker === 0xe1 && ascii(head, pos + 4, 4) === "Exif") {
      return parseTiff(head.subarray(pos + 10, pos + 2 + length));
    }
    if (marker === 0xda) break; // start of scan: no EXIF ahead
    pos += 2 + length;
  }
  return null;
}

function parseTiff(tiff: Uint8Array): Date | null {
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = ascii(tiff, 0, 2) === "II";
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(2) !== 0x2a) return null;

  const readIfd = (offset: number): Map<number, { type: number; count: number; valueOffset: number }> => {
    const entries = new Map<number, { type: number; count: number; valueOffset: number }>();
    if (offset + 2 > tiff.length) return entries;
    const n = u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 });
    }
    return entries;
  };
  const asciiValue = (entry?: { type: number; count: number; valueOffset: number }): string | undefined => {
    if (!entry || entry.type !== 2) return undefined;
    const start = entry.count <= 4 ? entry.valueOffset : u32(entry.valueOffset);
    return start + entry.count <= tiff.length ? ascii(tiff, start, entry.count) : undefined;
  };

  const ifd0 = readIfd(u32(4));
  const exifPointer = ifd0.get(0x8769);
  const exif = exifPointer ? readIfd(u32(exifPointer.valueOffset)) : new Map();
  const original = asciiValue(exif.get(0x9003));
  if (original) return parseExifDate(original, asciiValue(exif.get(0x9011)));
  const digitized = asciiValue(exif.get(0x9004));
  if (digitized) return parseExifDate(digitized, asciiValue(exif.get(0x9012)));
  const modified = asciiValue(ifd0.get(0x0132));
  return modified ? parseExifDate(modified) : null;
}

// ---------------------------------------------------------------------------------------------
// MP4 / MOV

const MP4_EPOCH_OFFSET = 2_082_844_800; // seconds between 1904-01-01 and 1970-01-01

function mp4Date(file: File): Date | null {
  const size = file.size ?? 0;
  const handle = file.open();
  try {
    const readAt = (offset: number, length: number): DataView | null => {
      if (offset + length > size) return null;
      handle.offset = offset;
      const bytes = handle.readBytes(length);
      return bytes.byteLength === length ? new DataView(bytes.buffer, bytes.byteOffset, length) : null;
    };
    const type = (v: DataView, o: number) =>
      String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    /** Returns [bodyOffset, atomEnd] for the atom whose header starts at `offset`. */
    const header = (offset: number): { name: string; body: number; end: number } | null => {
      const v = readAt(offset, 16);
      if (!v) return null;
      let atomSize: number = v.getUint32(0);
      let body = offset + 8;
      if (atomSize === 1) {
        atomSize = Number((BigInt(v.getUint32(8)) << 32n) | BigInt(v.getUint32(12)));
        body = offset + 16;
      } else if (atomSize === 0) atomSize = size - offset;
      if (atomSize < 8) return null;
      return { name: type(v, 4), body, end: offset + atomSize };
    };

    let pos = 0;
    for (let i = 0; i < MAX_ATOM_SCAN && pos + 8 <= size; i++) {
      const atom = header(pos);
      if (!atom) return null;
      if (atom.name === "moov") {
        let child = atom.body;
        for (let j = 0; j < MAX_ATOM_SCAN && child + 8 <= atom.end; j++) {
          const c = header(child);
          if (!c) return null;
          if (c.name === "mvhd") {
            const v = readAt(c.body, 12);
            if (!v) return null;
            const version = v.getUint8(0);
            const seconds =
              version === 1 ? Number((BigInt(v.getUint32(4)) << 32n) | BigInt(v.getUint32(8))) : v.getUint32(4);
            if (seconds === 0) return null;
            const date = new Date((seconds - MP4_EPOCH_OFFSET) * 1000);
            return plausible(date) ? date : null;
          }
          child = c.end;
        }
        return null;
      }
      pos = atom.end;
    }
    return null;
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// File name

function fileNameDate(name: string): Date | null {
  const m = name.match(/(20\d{2}|19\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  return plausible(date) ? date : null;
}

// ---------------------------------------------------------------------------------------------

export type CaptureTime = { date: Date; source: "exif" | "mp4" | "filename" };

/** Best guess at when the media was captured, or null when nothing usable is found. */
export function captureTime(uri: string, mimeType: string | undefined, fileName: string): CaptureTime | null {
  const type = (mimeType || "").toLowerCase();
  try {
    const file = new File(toFileUri(uri));
    if (type === "image/jpeg" || type === "image/jpg") {
      const handle = file.open();
      let head: Uint8Array;
      try {
        head = handle.readBytes(Math.min(HEADER_BYTES, file.size ?? HEADER_BYTES));
      } finally {
        handle.close();
      }
      const date = exifDate(head);
      if (date) return { date, source: "exif" };
    } else if (type.startsWith("video/")) {
      const date = mp4Date(file);
      if (date) return { date, source: "mp4" };
    }
  } catch {
    // unreadable or malformed: fall back to the name
  }
  const date = fileNameDate(fileName);
  return date ? { date, source: "filename" } : null;
}

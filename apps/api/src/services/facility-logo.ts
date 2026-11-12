import { ValidationError } from "../lib/errors.js";

/** B64-encoded image upload. Matches how credentials.ts already consumes uploads. */
export interface LogoUploadInput {
  filename: string;
  dataBase64: string;
  declaredType: string;
}

const IMAGE_SIGNATURES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const ALLOWED_TYPES = new Set(Object.keys(IMAGE_SIGNATURES));
const MAX_BYTES = 2 * 1024 * 1024;

/** Decodes the base64 body and verifies the magic bytes against the declared type. */
export function decodeAndVerifyLogo(input: LogoUploadInput): { bytes: Uint8Array; detectedType: string } {
  let bytes: Uint8Array;
  try {
    const binary = atob(input.dataBase64);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    throw new ValidationError("The uploaded image could not be decoded");
  }

  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw new ValidationError(`Image must be between 1 byte and ${MAX_BYTES} bytes (got ${bytes.length} bytes)`);
  }

  const declared = input.declaredType.trim().toLowerCase();
  if (!ALLOWED_TYPES.has(declared)) {
    throw new ValidationError("Image type is not permitted. Use PNG, JPEG or WebP.");
  }
  const signatures = IMAGE_SIGNATURES[declared]!;
  if (!signatures.some((s) => bytes.subarray(0, s.length).every((b, i) => b === s[i]))) {
    throw new ValidationError("Image does not match its declared type. Use PNG, JPEG or WebP.");
  }

  return { bytes, detectedType: declared };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks that carry metadata (timestamps, text, exif) and are dropped. */
const PNG_DROP_CHUNKS = new Set(["eXIf", "iTXt", "tEXt", "zTXt", "tIME"]);

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const out: number[] = [...PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sawIhdr = false;
  let sawIend = false;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = asciiAt(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new ValidationError("The uploaded image is a malformed PNG");
    if (type === "IHDR") sawIhdr = true;
    if (!PNG_DROP_CHUNKS.has(type)) {
      for (let i = offset; i < dataEnd + 4; i++) out.push(bytes[i]!);
    }
    offset = dataEnd + 4;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIhdr || !sawIend) throw new ValidationError("The uploaded image is not a valid PNG");
  return Uint8Array.from(out);
}

const JPEG_DROP_MARKERS = new Set([0xe1, 0xe2, 0xed, 0xef]); // APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC), APP15

function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let offset = 2;
  let sawSof = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new ValidationError("The uploaded image is a malformed JPEG");
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new ValidationError("The uploaded image is a malformed JPEG");
    }
    if (marker === 0xda) { // Start of Scan: SOS header segment, then entropy-coded data to EOI.
      if (!sawSof) throw new ValidationError("The uploaded image is a malformed JPEG");
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2) throw new ValidationError("The uploaded image is a malformed JPEG");
      const headerEnd = offset + 2 + length;
      if (headerEnd > bytes.length) throw new ValidationError("The uploaded image is a malformed JPEG");
      for (let i = offset; i < headerEnd; i++) out.push(bytes[i]!);
      offset = headerEnd;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] === 0xff) {
          const next = bytes[offset + 1]!;
          if (next === 0x00) { out.push(0xff, 0x00); offset += 2; continue; }
          if (next >= 0xd0 && next <= 0xd7) { out.push(0xff, next); offset += 2; continue; }
          if (next === 0xd9) { out.push(0xff, 0xd9); return Uint8Array.from(out); }
          throw new ValidationError("The uploaded image is a malformed JPEG");
        }
        out.push(bytes[offset]!);
        offset += 1;
      }
      throw new ValidationError("The uploaded image is missing its end-of-image marker");
    }
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) throw new ValidationError("The uploaded image is a malformed JPEG");
    const segEnd = offset + 2 + length;
    if (segEnd > bytes.length) throw new ValidationError("The uploaded image is a malformed JPEG");
    if (isJpegSof(marker)) sawSof = true;
    if (!JPEG_DROP_MARKERS.has(marker)) {
      for (let i = offset; i < segEnd; i++) out.push(bytes[i]!);
    }
    offset = segEnd;
  }
  throw new ValidationError("The uploaded image is a malformed JPEG");
}

const WEBP_DROP_CHUNKS = new Set(["EXIF", "XMP "]); // EXIF and XMP metadata chunks

function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WEBP") {
    throw new ValidationError("The uploaded image is a malformed WebP");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Array<{ start: number; length: number }> = [];
  let offset = 12;
  let vp8xFlagOffset = -1;
  let sawImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const type = asciiAt(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const padded = size + (size & 1);
    if (dataStart + padded > bytes.length) throw new ValidationError("The uploaded image is a malformed WebP");
    if (type === "VP8 " || type === "VP8L" || type === "VP8X") sawImageChunk = true;
    if (type === "VP8X") vp8xFlagOffset = dataStart;
    if (!WEBP_DROP_CHUNKS.has(type)) kept.push({ start: offset, length: 8 + padded });
    offset = dataStart + padded;
  }
  if (!sawImageChunk) throw new ValidationError("The uploaded image is not a valid WebP");
  const total = 12 + kept.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  out.set(bytes.subarray(0, 12), 0);
  const outView = new DataView(out.buffer);
  outView.setUint32(4, total - 8, true);
  let cursor = 12;
  for (const chunk of kept) {
    out.set(bytes.subarray(chunk.start, chunk.start + chunk.length), cursor);
    if (chunk.start === vp8xFlagOffset - 8) {
      // Clear the EXIF (0x08) and XMP (0x04) flag bits in VP8X: those chunks were removed.
      out[cursor + 8] = out[cursor + 8]! & ~0x0c;
    }
    cursor += chunk.length;
  }
  return out;
}

/**
 * Removes privacy metadata (EXIF/XMP/textual timestamps) from a signature-verified image.
 * Dependency-free: structural walk of the three permitted container formats. Everything that
 * is not a known image chunk/segment is preserved verbatim; anything unparseable is rejected.
 * This is not an antivirus scan; malware scanning remains a deployment concern (see REFACTOR.md Phase 4).
 */
export function sanitizeImage(bytes: Uint8Array, detectedType: string): Uint8Array {
  switch (detectedType) {
    case "image/png":
      return stripPngMetadata(bytes);
    case "image/jpeg":
      return stripJpegMetadata(bytes);
    case "image/webp":
      return stripWebpMetadata(bytes);
    default:
      throw new ValidationError("Image type is not permitted. Use PNG, JPEG or WebP.");
  }
}

export function extensionFor(detectedType: string): string {
  return EXTENSIONS[detectedType] ?? "png";
}

/** Generates a safe, random object key so the filename can never escape the tenant. */
export function objectKey(tenantId: string, detectedType: string): string {
  return `${tenantId}/${crypto.randomUUID()}.${extensionFor(detectedType)}`;
}

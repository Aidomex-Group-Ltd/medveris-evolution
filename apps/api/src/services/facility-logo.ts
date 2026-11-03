import { ValidationError } from "../lib/errors.js";

/** B64-encoded image upload. Matches how credentials.ts already consumes uploads. */
export interface LogoUploadInput {
  filename: string;
  dataBase64: string;
  declaredType: string;
}

const IMAGE_MIME_PREFIXES: Record<string, string[]> = {
  "image/png": ["\u0089PNG\r\n\x1a\n"],
  "image/jpeg": ["\xff\xd8\xff"],
  "image/webp": ["RIFF", "WEBP"],
};

const ALLOWED_EXTENSIONS = new Set(["png", "jpeg", "jpg", "webp"]);
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

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
  const signatures = IMAGE_MIME_PREFIXES[declared];
  if (!signatures || !signatures.some((s) => bytes.subarray(0, s.length).every((b, i) => b === s[i]))) {
    throw new ValidationError("Image type is not permitted or does not match the file signature. Use PNG, JPEG or WebP.");
  }

  if (!ALLOWED_EXTENSIONS.has(declared.replace("image/", ""))) {
    throw new ValidationError("Only PNG, JPEG and WebP images are permitted");
  }

  return { bytes, detectedType: declared };
}

/**
 * Runs a sharp pipeline: verify it decodes, strip EXIF (privacy), render a
 * 128 px thumbnail and a 512 px header render. Throws ValidationError on any
 * rejection.
 */
export async function processLogo(bytes: Uint8Array): Promise<Uint8Array> {
  const sharp = await import("sharp");

  let input: Uint8Array;
  try {
    input = new Uint8Array(bytes);
    await sharp(input).ensureAlpha().toBuffer({ resolveWithObject: true });
  } catch {
    throw new ValidationError("The uploaded file is not a valid image");
  }

  const { data } = await sharp(input)
    .ensureAlpha()
    .resize(128, 128, { fit: "contain", withoutEnlargement: true })
    .resize(512, 512, { fit: "contain", withoutEnlargement: true })
    .png({ quality: 90 })
    .toBuffer({ resolveWithObject: true });

  return data;
}

/** Generates a safe, random object key so the filename can never escape the tenant. */
export function objectKey(tenantId: string): string {
  const { randomUUID } = require("node:crypto");
  return `${tenantId}/${randomUUID()}.png`;
}


/** B64-encoded image upload. Matches how credentials.ts already consumes uploads. */
export interface LogoUploadInput {
  filename: string;
  dataBase64: string;
  declaredType: string;
}

const IMAGE_MIME_PREFIXES: Record<string, string[]> = {
  "image/png": ["\u0089PNG\r\n\x1a\n"],
  "image/jpeg": ["\xff\xd8\xff"],
  "image/webp": ["RIFF", "WEBP"],
};

const ALLOWED_EXTENSIONS = new Set(["png", "jpeg", "jpg", "webp"]);
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

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
  const signatures = IMAGE_MIME_PREFIXES[declared];
  if (!signatures || !signatures.some((s) => bytes.subarray(0, s.length).every((b, i) => b === s[i]))) {
    throw new ValidationError("Image type is not permitted or does not match the file signature. Use PNG, JPEG or WebP.");
  }

  if (!ALLOWED_EXTENSIONS.has(declared.replace("image/", ""))) {
    throw new ValidationError("Only PNG, JPEG and WebP images are permitted");
  }

  return { bytes, detectedType: declared };
}

/**
 * Runs a sharp pipeline: verify it decodes, strip EXIF (privacy), render a
 * 128 px thumbnail and a 512 px header render. Throws ValidationError on any
 * rejection.
 */
export async function processLogo(bytes: Uint8Array): Promise<Uint8Array> {
  const sharp = await import("sharp");

  let input: Uint8Array;
  try {
    input = new Uint8Array(bytes);
    await sharp(input).ensureAlpha().toBuffer({ resolveWithObject: true });
  } catch {
    throw new ValidationError("The uploaded file is not a valid image");
  }

  const { data } = await sharp(input)
    .ensureAlpha()
    .resize(128, 128, { fit: "contain", withoutEnlargement: true })
    .resize(512, 512, { fit: "contain", withoutEnlargement: true })
    .png({ quality: 90 })
    .toBuffer({ resolveWithObject: true });

  return data;
}

/** Generates a safe, random object key so the filename can never escape the tenant. */
export function objectKey(tenantId: string): string {
  const { randomUUID } = require("node:crypto");
  return `${tenantId}/${randomUUID()}.png`;
}

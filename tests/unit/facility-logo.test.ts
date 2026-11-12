import { describe, expect, it } from "vitest";
import { decodeAndVerifyLogo, sanitizeImage, extensionFor } from "../../apps/api/src/services/facility-logo.js";

function ascii(s: string): number[] {
  return [...s].map((ch) => ch.charCodeAt(0));
}

function pngChunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...ascii(type), ...data, 0, 0, 0, 0];
}

function minimalPng(withExif: boolean): number[] {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  out.push(...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  if (withExif) out.push(...pngChunk("eXIf", [...ascii("Exif\0\0metadata"), 1, 2, 3]));
  out.push(...pngChunk("tEXt", [...ascii("Author\0secret author")]));
  out.push(...pngChunk("IDAT", [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]));
  out.push(...pngChunk("IEND", []));
  return out;
}

function jpegSegment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >>> 8) & 255, length & 255, ...payload];
}

function minimalJpeg(): number[] {
  const out = [0xff, 0xd8];
  out.push(...jpegSegment(0xe1, [...ascii("Exif\0\0secret metadata bytes")]));
  out.push(...jpegSegment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
  out.push(...jpegSegment(0xffed - 0x100, [...ascii("IPTC secret")])); // APP13
  out.push(...jpegSegment(0xda, [1, 1, 0, 0, 63, 0]));
  out.push(0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd0, 0x44, 0xff, 0xd9);
  return out;
}

function le32(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}

function riffChunk(fourcc: string, payload: number[]): number[] {
  return [...ascii(fourcc), ...le32(payload.length), ...payload, ...(payload.length % 2 ? [0] : [])];
}

function minimalWebp(): number[] {
  const vp8x = [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // flags: EXIF | XMP set
  const body = [
    ...riffChunk("VP8X", vp8x),
    ...riffChunk("EXIF", [...ascii("Exif\0\0secret")]),
    ...riffChunk("XMP ", [...ascii("<xmp>secret</xmp>")]),
    ...riffChunk("VP8 ", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  ];
  return [...ascii("RIFF"), ...le32(body.length + 4), ...ascii("WEBP"), ...body];
}

describe("facility logo sanitizer", () => {
  it("strips PNG text and EXIF chunks but keeps image data", () => {
    const out = Buffer.from(sanitizeImage(Uint8Array.from(minimalPng(true)), "image/png")).toString("latin1");
    expect(out).not.toContain("eXIf");
    expect(out).not.toContain("tEXt");
    expect(out).not.toContain("secret author");
    expect(out).toContain("IHDR");
    expect(out).toContain("IDAT");
    expect(out).toContain("IEND");
  });

  it("strips JPEG EXIF/IPTC segments and keeps the entropy-coded data", () => {
    const out = sanitizeImage(Uint8Array.from(minimalJpeg()), "image/jpeg");
    const latin1 = Buffer.from(out).toString("latin1");
    expect(latin1.startsWith("\xff\xd8")).toBe(true);
    expect(latin1.endsWith("\xff\xd9")).toBe(true);
    expect(latin1).not.toContain("Exif\0\0secret");
    expect(latin1).not.toContain("IPTC secret");
    expect(out).toContain(0xff);
    // entropy-coded bytes (including the stuffed FF 00 and restart marker) survive verbatim
    expect([...out]).toContain(0x11);
    expect([...out]).toContain(0xd0);
  });

  it("strips WebP EXIF/XMP chunks and clears the VP8X metadata flags", () => {
    const out = sanitizeImage(Uint8Array.from(minimalWebp()), "image/webp");
    const latin1 = Buffer.from(out).toString("latin1");
    expect(latin1).not.toContain("EXIF");
    expect(latin1).not.toContain("XMP ");
    expect(latin1).not.toContain("secret");
    expect(latin1).toContain("VP8X");
    expect(latin1).toContain("VP8 ");
    // flags byte of VP8X is the byte right after the VP8X chunk header
    const flags = latin1.indexOf("VP8X");
    expect(latin1.charCodeAt(flags + 8) & 0x0c).toBe(0x00);
    expect(latin1.startsWith("RIFF")).toBe(true);
  });

  it("rejects truncated and malformed inputs for all three types", () => {
    expect(() => sanitizeImage(Uint8Array.from(minimalPng(false).slice(0, 20)), "image/png")).toThrow();
    expect(() => sanitizeImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xda]), "image/jpeg")).toThrow();
    expect(() => sanitizeImage(Uint8Array.from(minimalWebp().slice(0, 14)), "image/webp")).toThrow();
    expect(() => sanitizeImage(Uint8Array.from([1, 2, 3]), "image/png")).toThrow();
  });
});

describe("facility logo decode and extensions", () => {
  it("verifies the declared signature and rejects executable disguises", () => {
    const pngB64 = Buffer.from(minimalPng(false)).toString("base64");
    const ok = decodeAndVerifyLogo({ filename: "logo.png", dataBase64: pngB64, declaredType: "image/png" });
    expect(ok.detectedType).toBe("image/png");
    const mz = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 3, 0, 0, 0]).toString("base64");
    expect(() => decodeAndVerifyLogo({ filename: "logo.png", dataBase64: mz, declaredType: "image/png" })).toThrow();
    const wrongDeclared = Buffer.from(minimalJpeg()).toString("base64");
    expect(() => decodeAndVerifyLogo({ filename: "logo.png", dataBase64: wrongDeclared, declaredType: "image/png" })).toThrow();
  });

  it("maps detected types to safe extensions", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/webp")).toBe("webp");
  });
});

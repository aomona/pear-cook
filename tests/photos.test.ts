import { describe, expect, it } from "vitest";

import {
  ALLOWED_MEDIA_TYPES,
  MAX_PHOTO_BYTES,
  mediaTypeFromMagic,
  sha256Hex,
  validatePhotoBytes,
} from "../src/worker/photos";

function makeJpeg(): Uint8Array {
  const body = new Uint8Array(64);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[3] = 0xe0;
  return body;
}

function makePng(): Uint8Array {
  const body = new Uint8Array(64);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return body;
}

function makeWebP(): Uint8Array {
  const body = new Uint8Array(64);
  // RIFF....WEBP
  body.set([0x52, 0x49, 0x46, 0x46]);
  body.set([0x00, 0x00, 0x00, 0x00], 4);
  body.set([0x57, 0x45, 0x42, 0x50], 8);
  return body;
}

function makeHtmlWithJpegExtension(): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode("<html><body>Not an image</body></html>");
}

describe("photo magic bytes detection", () => {
  it.each([
    { make: makeJpeg, expected: "image/jpeg" },
    { make: makePng, expected: "image/png" },
    { make: makeWebP, expected: "image/webp" },
  ])("detects $expected from magic bytes", ({ make, expected }) => {
    expect(mediaTypeFromMagic(make())).toBe(expected);
  });

  it("returns null for non-image bytes", () => {
    expect(mediaTypeFromMagic(makeHtmlWithJpegExtension())).toBeNull();
    expect(mediaTypeFromMagic(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeNull();
    expect(mediaTypeFromMagic(new Uint8Array([0xff, 0xd9, 0xff]))).toBeNull();
  });

  it("returns null when bytes are too short", () => {
    expect(mediaTypeFromMagic(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(mediaTypeFromMagic(new Uint8Array([]))).toBeNull();
  });

  it("rejects RIFF that is not WEBP", () => {
    const body = new Uint8Array(64);
    body.set([0x52, 0x49, 0x46, 0x46]);
    body.set([0x00, 0x00, 0x00, 0x00], 4);
    body.set([0x41, 0x56, 0x49, 0x20], 8); // "AVI " instead of "WEBP"
    expect(mediaTypeFromMagic(body)).toBeNull();
  });
});

describe("photo content type validation", () => {
  it("accepts matching declared and detected type", () => {
    const jpeg = makeJpeg();
    const result = validatePhotoBytes(jpeg, "image/jpeg");
    expect(result).toBe("image/jpeg");
  });

  it("accepts detected type when no declared type is given", () => {
    const png = makePng();
    const result = validatePhotoBytes(png, null);
    expect(result).toBe("image/png");
  });

  it("rejects spoofed declared type", () => {
    const jpeg = makeJpeg();
    const result = validatePhotoBytes(jpeg, "image/png");
    expect(result).toBeInstanceOf(Response);
  });

  it("rejects disallowed declared type even if magic matches", () => {
    const body = new Uint8Array(64);
    body[0] = 0x47;
    body[1] = 0x49;
    body[2] = 0x46;
    const result = validatePhotoBytes(body, "image/gif");
    expect(result).toBeInstanceOf(Response);
  });

  it("rejects HTML masquerading as JPEG", () => {
    const html = makeHtmlWithJpegExtension();
    const result = validatePhotoBytes(html, "image/jpeg");
    expect(result).toBeInstanceOf(Response);
  });
});

describe("photo size limits", () => {
  it("MAX_PHOTO_BYTES equals 8 MiB", () => {
    expect(MAX_PHOTO_BYTES).toBe(8 * 1024 * 1024);
  });

  it("ALLOWED_MEDIA_TYPES contains only jpeg/png/webp", () => {
    expect(ALLOWED_MEDIA_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});

describe("sha256 helper", () => {
  it("returns consistent hex for identical input", async () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const a = await sha256Hex(data.buffer);
    const b = await sha256Hex(data.buffer);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different digests for different input", async () => {
    const a = await sha256Hex(new Uint8Array([0x01]).buffer);
    const b = await sha256Hex(new Uint8Array([0x02]).buffer);
    expect(a).not.toBe(b);
  });
});

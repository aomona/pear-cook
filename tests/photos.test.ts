import { describe, expect, it } from "vitest";

import {
  ALLOWED_MEDIA_TYPES,
  MAX_PHOTO_BYTES,
  mediaTypeFromMagic,
  sha256Hex,
} from "../src/worker/photos";
import { normalizedRecipeSchema } from "../src/domain/domain";
import { buildRecipeImagePrompt, decodeGeneratedImage } from "../src/worker/recipes";

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

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
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

describe("generated image validation", () => {
  it("decodes matching image data", () => {
    const result = decodeGeneratedImage(encodeBase64(makeJpeg()), "image/jpeg");
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.bytes).toEqual(makeJpeg());
  });

  it("detects a media type when Gemini omits it", () => {
    expect(decodeGeneratedImage(encodeBase64(makePng()), undefined).mediaType).toBe("image/png");
  });

  it("rejects a mismatched declared type", () => {
    expect(() => decodeGeneratedImage(encodeBase64(makeJpeg()), "image/png")).toThrow(
      "image/jpeg bytes as image/png",
    );
  });

  it("rejects non-image model output", () => {
    expect(() =>
      decodeGeneratedImage(encodeBase64(makeHtmlWithJpegExtension()), "image/jpeg"),
    ).toThrow("unsupported image format");
  });
});

describe("generated image prompt", () => {
  it("grounds the image in the reviewed recipe and forbids unlisted additions", () => {
    const recipe = normalizedRecipeSchema.parse({
      id: "recipe-1",
      title: "Tomato pasta",
      servings: 2,
      ingredients: [
        { name: "tomato", quantity: "2" },
        { name: "spaghetti", quantity: "160 g" },
      ],
      instructions: [
        {
          title: "Serve",
          instruction: "Twirl the pasta onto two plates.",
          durationSeconds: 60,
        },
      ],
      sourceRefs: [{ sourceId: "source-1" }],
    });
    const prompt = buildRecipeImagePrompt(recipe);
    expect(prompt).toContain("Dish: Tomato pasta");
    expect(prompt).toContain("tomato (2), spaghetti (160 g)");
    expect(prompt).toContain("Twirl the pasta onto two plates.");
    expect(prompt).toContain("ingredients not listed");
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

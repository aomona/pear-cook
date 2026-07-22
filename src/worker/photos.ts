import type { PearEnv, PearRequestContext } from "@pear-agent/cloudflare";

export type PhotoEnv = PearEnv;

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function mediaTypeFromMagic(bytes: Uint8Array): AllowedMediaType | null {
  if (bytes.length < 3) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    // WebP: RIFF....WEBP
    if (
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  return null;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


async function getPhotoSource(
  env: PhotoEnv,
  planId: string,
  sourceId: string,
  actorId: string,
): Promise<{ mediaType: AllowedMediaType; buffer: ArrayBuffer; byteSize: number } | null> {
  const source = await env.DB.prepare(
    `SELECT ps.raw_object_key, ps.media_type, ps.status
     FROM plan_sources ps
     JOIN plan_artifacts pa ON pa.id = ps.plan_artifact_id
     WHERE ps.id = ? AND ps.plan_artifact_id = ? AND pa.owner_actor_id = ? AND ps.kind = 'file'`,
  )
    .bind(sourceId, planId, actorId)
    .first<{ raw_object_key: string | null; media_type: string; status: string }>();

  if (!source?.raw_object_key || source.status !== "ready") return null;

  const object = await env.RAW_INPUTS.get(source.raw_object_key);
  if (!object) return null;

  const buffer = (await object.arrayBuffer()) as ArrayBuffer;
  const bytes = new Uint8Array(buffer);
  const mediaType = source.media_type as AllowedMediaType;

  // Paranoid re-check: ensure what's in R2 still matches stored media type
  if (mediaTypeFromMagic(bytes) !== mediaType) return null;

  return { mediaType, buffer, byteSize: bytes.length };
}


async function handlePhotoGet(
  request: Request,
  env: PhotoEnv,
  planId: string,
  sourceId: string,
  context: PearRequestContext,
): Promise<Response> {
  const photo = await getPhotoSource(env, planId, sourceId, context.actorId);
  if (!photo) return jsonError("Photo not found", 404);

  return new Response(photo.buffer, {
    status: 200,
    headers: {
      "Content-Type": photo.mediaType,
      "Content-Length": String(photo.byteSize),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, immutable, max-age=31536000",
    },
  });
}

export async function handlePhotoApi(
  request: Request,
  env: PhotoEnv,
  context: PearRequestContext,
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/plans\/([^/]+)\/photos(?:\/([^/]+))?$/);
  if (!match) return jsonError("Not found", 404);
  const planId = decodeURIComponent(match[1]);
  const sourceId = match[2] ? decodeURIComponent(match[2]) : null;


  if (request.method === "GET" && sourceId) {
    return handlePhotoGet(request, env, planId, sourceId, context);
  }

  return jsonError("Method not allowed", 405);
}

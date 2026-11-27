import { join } from "node:path";

/**
 * Where Hermes's gateway keeps the files a chat sends, as (current, legacy)
 * folders under a profile's home. Hermes uses a legacy folder in place of the
 * current one while it exists, so an install that predates the `cache`
 * folder keeps its files in the legacy one, and both are listed.
 */
const MEDIA_CACHES: readonly (readonly [string, string])[] = [
  ["cache/images", "image_cache"],
  ["cache/documents", "document_cache"],
  ["cache/audio", "audio_cache"],
  ["cache/video", "video_cache"],
  ["cache/videos", "video_cache"],
];

/** Every folder under a profile's home that may hold a chat's files; one that does not exist holds none. */
export function chatCacheDirs(profileHome: string): string[] {
  return [...new Set(MEDIA_CACHES.flat())].map((name) => join(profileHome, name));
}

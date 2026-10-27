/**
 * A version's source files from the `SOURCES` bucket, for the bot page. They are user-written
 * code: the page shows them as plain text (React escapes it), never as HTML or Markdown.
 *
 * The object is the deploy API's `SourceArchive` JSON (#20): `{ format: "zerosnake-sources@1",
 * files: [{ path, content }] }`. Anything else is treated as missing rather than trusted.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { bots, users, versions } from "../db/schema";

export const SOURCE_ARCHIVE_FORMAT = "zerosnake-sources@1";

/** Files longer than this are cut for display; the archive itself is capped at 1 MiB. */
export const MAX_SHOWN_CHARS = 200_000;

export interface SourceFile {
  path: string;
  content: string;
  /** `content` was cut to `MAX_SHOWN_CHARS`. */
  truncated: boolean;
  /**
   * Contains bidirectional control characters, which can make code read differently from how
   * it runs ("Trojan Source"). The page warns about it.
   */
  bidi: boolean;
}

export type Sources =
  | { status: "ok"; files: SourceFile[] }
  /** No object at the key (not uploaded yet, or a seed row without one). */
  | { status: "missing" }
  /** An object that isn't a `SourceArchive`. */
  | { status: "invalid" };

const BIDI = /[‪-‮⁦-⁩]/;

/** Parses a `SourceArchive`; `null` if it isn't one. Files come back sorted by path. */
export function parseSourceArchive(text: string): SourceFile[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const archive = value as { format?: unknown; files?: unknown };
  if (archive.format !== SOURCE_ARCHIVE_FORMAT || !Array.isArray(archive.files)) return null;
  const files: SourceFile[] = [];
  for (const file of archive.files as unknown[]) {
    if (typeof file !== "object" || file === null) return null;
    const { path, content } = file as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || typeof content !== "string" || path === "") return null;
    const truncated = content.length > MAX_SHOWN_CHARS;
    files.push({
      path,
      content: truncated ? content.slice(0, MAX_SHOWN_CHARS) : content,
      truncated,
      bidi: BIDI.test(content) || BIDI.test(path),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function readSources(bucket: R2Bucket, key: string): Promise<Sources> {
  const object = await bucket.get(key);
  if (!object) return { status: "missing" };
  const files = parseSourceArchive(await object.text());
  return files ? { status: "ok", files } : { status: "invalid" };
}

/**
 * Sources of a version by id; `null` if there is no such version, or its author is banned or
 * deleted their account (whose profile and bot pages are gone too).
 */
export async function readVersionSources(
  db: Db,
  bucket: R2Bucket,
  versionId: string,
): Promise<Sources | null> {
  const [row] = await db
    .select({ key: versions.sourceKey })
    .from(versions)
    .innerJoin(bots, eq(bots.id, versions.botId))
    .innerJoin(users, eq(users.id, bots.ownerId))
    .where(
      and(
        eq(versions.id, versionId),
        isNull(users.bannedAt),
        isNull(users.deletedAt),
        isNotNull(users.username),
      ),
    )
    .limit(1);
  return row ? readSources(bucket, row.key) : null;
}

import type { CapturedPage, ImageFormat, RunOptions, ViewerMeta, ViewerSession } from './types.ts';

/**
 * Page fetching: the stage that turns a viewer token into rendered page images.
 *
 * Drive's /viewer/img endpoint is directly addressable by page index, so this needs none
 * of the scroll-and-screenshot choreography the viewer UI would otherwise force. Pages can
 * be pulled in any order, concurrently, at a chosen width, with no browser involved.
 *
 * Three constraints do real damage if handled naively, and shape everything below.
 *
 * 1. Concurrent completion order is not page order. Building every request up front and
 *    Promise.all-ing it both ignores the concurrency bound and returns results in whatever
 *    order the network settled them. A PDF assembled from that is silently scrambled - it
 *    opens fine and is wrong. Hence a bounded worker pool writing into a slot array indexed
 *    by page number, never an append-ordered list.
 *
 * 2. The endpoint cannot serve JPEG. format=jpeg, jpeg=true and mimetype=image/jpeg were
 *    all tested against the live viewer and all still return PNG. PNG at w=1600 is ~930 KB
 *    per page, so a 159-page deck assembles to ~148 MB. Re-encoding through sharp is
 *    therefore the default rather than an optimisation.
 *
 * 3. An expired token does not fail cleanly - it returns an HTML error body with an image
 *    request's status code. Trusting the status alone would embed markup as page content,
 *    so every response is checked for PNG magic bytes before it is accepted.
 */

const VIEWER_ORIGIN = 'https://drive.google.com';

/** Four attempts covers a transient 429 or a dropped connection without stalling a run. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 400;

/** \x89 P N G - the first four bytes of every PNG. Cheap proof the body is really an image. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;

/**
 * sharp ships as CommonJS with `export =`, so the callable lives on the module's default
 * export rather than on the namespace object. Only the one call shape is needed here.
 */
type SharpFactory = (input: Uint8Array) => import('sharp').Sharp;

/**
 * sharp is a native module. If its binary did not build for this platform we still want a
 * usable PDF, so the failure degrades to lossless PNG rather than aborting the run.
 * Resolved once and cached: 159 pages must not each pay for a failed import.
 */
let sharpPromise: Promise<SharpFactory | null> | undefined;

function loadSharp(): Promise<SharpFactory | null> {
  // A plain if rather than ??=, so the return type narrows to a defined promise.
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => (mod.default ?? mod) as unknown as SharpFactory)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `\nWARNING: sharp could not be loaded (${reason}).\n` +
            '  Falling back to embedding lossless PNG. The PDF will be valid but very large\n' +
            '  (roughly 930 KB per page at w=1600).\n',
        );
        return null;
      });
  }
  return sharpPromise;
}

export async function capturePages(
  session: ViewerSession,
  meta: ViewerMeta,
  opts: RunOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<CapturedPage[]> {
  // Anything above maxPageWidth is rejected by the endpoint with a 400, so clamp rather
  // than let a generous --width flag fail every page.
  const width = Math.min(opts.width, meta.maxPageWidth);
  const total = meta.pages;

  if (total <= 0) {
    throw new Error(`capturePages: the viewer reported ${total} pages; nothing to fetch.`);
  }

  const sharpModule = opts.jpegQuality === null ? null : await loadSharp();
  const quality = opts.jpegQuality;

  // Indexed slots, not an append list: a page can only ever land in its own position.
  const slots = new Array<CapturedPage | undefined>(total);

  let nextIndex = 0;
  let completed = 0;

  const workerCount = Math.max(1, Math.min(opts.concurrency, total));

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;

      const png = await fetchPageWithRetry(session.viewerId, index, width);
      slots[index] = await encodePage(index, png, sharpModule, quality);

      completed += 1;
      onProgress?.(completed, total);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));

  // A hole here means a worker exited without throwing, which should be impossible.
  // Assert it anyway: a missing page must never reach the assembler.
  const pages: CapturedPage[] = [];
  const missing: number[] = [];
  for (let i = 0; i < total; i += 1) {
    const page = slots[i];
    if (page) pages.push(page);
    else missing.push(i);
  }
  if (missing.length > 0) {
    throw new Error(
      `capturePages: ${missing.length} page(s) were never captured (${missing.slice(0, 10).join(', ')}` +
        `${missing.length > 10 ? ', ...' : ''}). Re-run; if it repeats, lower --concurrency.`,
    );
  }

  return pages;
}

/** Build the image URL. Omitting `webp` is what makes the response PNG rather than WebP. */
function pageImageUrl(viewerId: string, index: number, width: number): string {
  const url = new URL(`${VIEWER_ORIGIN}/viewer/img`);
  url.searchParams.set('id', viewerId);
  url.searchParams.set('dsmi', 'texmex');
  url.searchParams.set('auditContext', 'forDisplay');
  url.searchParams.set('page', String(index));
  url.searchParams.set('skiphighlight', 'true');
  url.searchParams.set('w', String(width));
  return url.toString();
}

async function fetchPageWithRetry(
  viewerId: string,
  index: number,
  width: number,
): Promise<Uint8Array> {
  const url = pageImageUrl(viewerId, index, width);
  let lastProblem = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // The token authenticates by itself; sending cookies would bind the call to whatever
      // account happens to be present and is exactly the coupling this tool avoids.
      const response = await fetch(url, { credentials: 'omit', headers: { accept: 'image/*' } });

      if (response.status === 400) {
        // Deterministic and permanent: an out-of-range page or an oversized width. Retrying
        // wastes the budget and hides the real cause.
        throw new PermanentPageError(
          `page ${index} at w=${width} was rejected with HTTP 400. ` +
            'The page index is out of range or the width exceeds maxPageWidth.',
        );
      }

      if (!response.ok) {
        lastProblem = `HTTP ${response.status} ${response.statusText}`;
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (isPng(bytes)) return bytes;

        // An expired token answers with HTML, not an image. Retrying is worth one cycle in
        // case it was a transient edge error, but this is usually terminal for the run.
        lastProblem = `response was not a PNG (content-type ${response.headers.get('content-type') ?? 'unknown'}, ${bytes.length} bytes)`;
      }
    } catch (error) {
      if (error instanceof PermanentPageError) throw error;
      lastProblem = error instanceof Error ? error.message : String(error);
    }

    if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
  }

  throw new Error(
    `Failed to fetch page ${index} after ${MAX_ATTEMPTS} attempts (${lastProblem}). ` +
      'If the body was not a PNG the viewer token has most likely expired - re-run the command.',
  );
}

/** Exponential with jitter, so a rate-limited burst does not resynchronise on retry. */
function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PermanentPageError extends Error {}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 24 && PNG_MAGIC.every((byte, i) => bytes[i] === byte);
}

async function encodePage(
  index: number,
  png: Uint8Array,
  sharpModule: SharpFactory | null,
  quality: number | null,
): Promise<CapturedPage> {
  if (sharpModule && quality !== null) {
    // mozjpeg buys roughly 10% at the same visual quality, which is worth it across 159 pages.
    const { data, info } = await sharpModule(png)
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    return {
      index,
      bytes: new Uint8Array(data),
      format: 'jpeg' satisfies ImageFormat,
      width: info.width,
      height: info.height,
    };
  }

  // PNG path: dimensions come from the IHDR chunk, which is always the first chunk and
  // always at a fixed offset. Cheaper and dependency-free compared with decoding the image.
  const { width, height } = readPngDimensions(png, index);
  return { index, bytes: png, format: 'png' satisfies ImageFormat, width, height };
}

/**
 * PNG layout: 8-byte signature, then the IHDR chunk as 4-byte length, 4-byte type, then
 * width and height as big-endian uint32 at offsets 16 and 20.
 */
function readPngDimensions(bytes: Uint8Array, index: number): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);

  if (width <= 0 || height <= 0) {
    throw new Error(
      `Page ${index} reported impossible dimensions ${width}x${height}; the PNG header is malformed.`,
    );
  }
  return { width, height };
}

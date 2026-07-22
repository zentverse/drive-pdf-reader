/**
 * Shared contract for the Drive view-only PDF extractor.
 *
 * Every stage in the pipeline speaks these types and nothing else, so the stages stay
 * independently testable and the browser-dependent part (token capture) is quarantined
 * behind a plain data structure.
 *
 * Endpoint facts these types encode, all verified against a live 159-page document
 * rather than assumed:
 *   - /viewer/meta?id={viewerId}  -> XSSI-prefixed JSON {"pages":N,"maxPageWidth":W}
 *   - /viewer/img?id={viewerId}&page={i}&w={px}  -> PNG (WebP only if &webp=true)
 *   - `page` is 0-based; page === pages returns HTTP 400
 *   - `w` above maxPageWidth returns HTTP 400
 *   - the viewerId works with credentials omitted, so page fetching needs no browser
 */

/** A Drive URL reduced to the only part that identifies the document. */
export interface ResolvedTarget {
  fileId: string;
  kind: 'file' | 'folder';
  /** The URL as supplied, retained for error messages. */
  sourceUrl: string;
}

/**
 * The short-lived credential the viewer hands out.
 *
 * This is NOT the file ID. It is an opaque `ACFrOgB...` token minted per viewer session
 * and embedded in every /viewer/* request. Capturing it is the only step that needs a
 * real browser; everything downstream is plain HTTP.
 */
export interface ViewerSession {
  viewerId: string;
  /** Document title from the viewer, already sanitised for use as a filename. */
  title: string;
}

/** Response of /viewer/meta, after the `)]}'` XSSI prefix is stripped. */
export interface ViewerMeta {
  /** Total page count. Valid page indices are 0 .. pages-1. */
  pages: number;
  /** Largest `w` the image endpoint will honour. Anything larger is a 400. */
  maxPageWidth: number;
}

export type ImageFormat = 'png' | 'jpeg';

/** One rendered page, in memory, ready to embed. */
export interface CapturedPage {
  /** 0-based, matching the endpoint's own indexing. */
  index: number;
  bytes: Uint8Array;
  format: ImageFormat;
  width: number;
  height: number;
}

export interface RunOptions {
  /**
   * Requested render width in pixels. Clamped to meta.maxPageWidth.
   * Higher is sharper and much larger: at w=3200 a slide page is ~2.4 MB of PNG.
   */
  width: number;
  /**
   * Re-encode pages to JPEG at this quality before embedding.
   * The endpoint cannot serve JPEG, and raw PNG for a long deck runs to hundreds of
   * megabytes, so this is on by default. Set to null to embed the original PNG.
   */
  jpegQuality: number | null;
  /** Concurrent page fetches. The endpoint tolerates this comfortably. */
  concurrency: number;
  outDir: string;
  /** Keep the per-page images in work/ instead of discarding them after assembly. */
  keepPages: boolean;
}

/** Result of the post-assembly sanity pass. A failed check must abort the run. */
export interface VerifyReport {
  ok: boolean;
  expectedPages: number;
  actualPages: number;
  /** 0-based indices that came back essentially blank. */
  blankPages: number[];
  /** Groups of indices that rendered identically, which usually means a stalled fetch. */
  duplicateGroups: number[][];
  bytes: number;
  problems: string[];
}

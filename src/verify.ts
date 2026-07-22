import crypto from 'node:crypto';
import type { CapturedPage, ViewerMeta, VerifyReport } from './types.ts';

/**
 * The gate between "we produced a file" and "we produced the document".
 *
 * A truncated or half-blank PDF looks perfectly healthy to a PDF reader, so nothing
 * downstream will notice it. This pass is the only thing standing between a stalled
 * fetch and a user who believes they have all 159 pages. It is pure and synchronous so
 * it can be unit-tested against fabricated page arrays without touching Drive.
 */

/** Below this a page cannot be a real render, whatever the median says. */
const BLANK_FLOOR_BYTES = 2 * 1024;

/** A page this far under the median is blank or a render error, not just a sparse slide. */
const BLANK_RATIO = 0.15;

/** A PDF smaller than this has no chance of containing pages. */
const MIN_PDF_BYTES = 1024;

export function verifyRun(
  pages: CapturedPage[],
  meta: ViewerMeta,
  pdfBytes: Uint8Array,
): VerifyReport {
  const problems: string[] = [];
  const expectedPages = meta.pages;
  const actualPages = pages.length;

  if (actualPages !== expectedPages) {
    problems.push(
      `Captured ${actualPages} pages but the viewer reports ${expectedPages}. ` +
        'The PDF is incomplete - re-run; if it repeats, lower --concurrency.',
    );
  }

  const { missing, duplicated, outOfRange } = auditIndices(pages, expectedPages);

  if (missing.length > 0) {
    problems.push(
      `Missing page indices: ${summariseIndices(missing)}. Re-run to refetch the gaps.`,
    );
  }
  if (duplicated.length > 0) {
    problems.push(
      `Page indices captured more than once: ${summariseIndices(duplicated)}. ` +
        'The page list was built wrongly - re-run and report this if it persists.',
    );
  }
  if (outOfRange.length > 0) {
    problems.push(
      `Page indices outside 0..${expectedPages - 1}: ${summariseIndices(outOfRange)}. ` +
        'These pages do not belong to this document and must not be shipped.',
    );
  }

  // Byte length is the only blankness signal available without decoding every image, and
  // decoding 159 PNGs to count pixels is not worth it.
  //
  // The two thresholds are deliberately not equivalent. Below the absolute floor a page
  // cannot be a real render at all, so that fails the run. The median-relative test is
  // only a suspicion: in a photo-heavy deck a legitimate title or section slide compresses
  // far below the median, and failing a complete 159-page capture over a sparse slide
  // would be a worse outcome than the thing the check exists to catch.
  const { certain: blankPages, suspicious } = findBlankPages(pages);
  if (blankPages.length > 0) {
    problems.push(
      `Pages too small to be a real render: ${summariseIndices(blankPages)}. ` +
        'Re-run; if the same indices come back this small the fetch is failing for them.',
    );
  }
  if (suspicious.length > 0) {
    problems.push(
      `Warning: unusually small renders at ${summariseIndices(suspicious)}. ` +
        'Typically sparse slides (titles, section dividers) - open them and confirm.',
    );
  }

  const duplicateGroups = findDuplicateGroups(pages);
  if (duplicateGroups.length > 0) {
    // Warning only: section dividers and blank separators legitimately render identically,
    // so this must never fail the run on its own.
    problems.push(
      `Warning: identical renders at ${duplicateGroups.map((g) => `[${summariseIndices(g)}]`).join(', ')}. ` +
        'Usually harmless (repeated dividers) - open those pages and confirm they really match.',
    );
  }

  const bytes = pdfBytes.length;
  const pdfTooSmall = bytes < MIN_PDF_BYTES;
  if (pdfTooSmall) {
    problems.push(
      `The assembled PDF is only ${bytes} bytes, which cannot contain any pages. ` +
        'Treat the run as failed and re-run.',
    );
  }

  const ok =
    actualPages === expectedPages &&
    missing.length === 0 &&
    duplicated.length === 0 &&
    outOfRange.length === 0 &&
    blankPages.length === 0 &&
    !pdfTooSmall;

  return { ok, expectedPages, actualPages, blankPages, duplicateGroups, bytes, problems };
}

function auditIndices(
  pages: CapturedPage[],
  expectedPages: number,
): { missing: number[]; duplicated: number[]; outOfRange: number[] } {
  const counts = new Map<number, number>();
  const outOfRange: number[] = [];

  for (const page of pages) {
    counts.set(page.index, (counts.get(page.index) ?? 0) + 1);
    if (!Number.isInteger(page.index) || page.index < 0 || page.index >= expectedPages) {
      outOfRange.push(page.index);
    }
  }

  const missing: number[] = [];
  for (let i = 0; i < expectedPages; i += 1) {
    if (!counts.has(i)) missing.push(i);
  }

  const duplicated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([index]) => index)
    .sort((a, b) => a - b);

  return { missing, duplicated, outOfRange: [...new Set(outOfRange)].sort((a, b) => a - b) };
}

/**
 * `certain` fails the run; `suspicious` only warns. See the call site for why the
 * median-relative test must not be treated as proof of a broken page.
 */
function findBlankPages(pages: CapturedPage[]): { certain: number[]; suspicious: number[] } {
  if (pages.length === 0) return { certain: [], suspicious: [] };

  const relative = median(pages.map((page) => page.bytes.length)) * BLANK_RATIO;
  const certain: number[] = [];
  const suspicious: number[] = [];

  for (const page of pages) {
    const size = page.bytes.length;
    if (size < BLANK_FLOOR_BYTES) certain.push(page.index);
    else if (size < relative) suspicious.push(page.index);
  }

  return {
    certain: certain.sort((a, b) => a - b),
    suspicious: suspicious.sort((a, b) => a - b),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function findDuplicateGroups(pages: CapturedPage[]): number[][] {
  const byHash = new Map<string, number[]>();

  for (const page of pages) {
    const hash = crypto.createHash('sha1').update(page.bytes).digest('hex');
    const group = byHash.get(hash);
    if (group) group.push(page.index);
    else byHash.set(hash, [page.index]);
  }

  return [...byHash.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort((a, b) => a - b))
    .sort((a, b) => a[0]! - b[0]!);
}

/** Keeps a 159-page failure readable: 0-4, 7, 9-11 rather than every index spelled out. */
function summariseIndices(indices: number[]): string {
  if (indices.length === 0) return '';
  const sorted = [...indices].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0]!;
  let previous = start;

  for (const index of sorted.slice(1)) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    runs.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = index;
    previous = index;
  }
  runs.push(start === previous ? `${start}` : `${start}-${previous}`);
  return runs.join(', ');
}

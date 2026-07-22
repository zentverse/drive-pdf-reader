import { resolveTarget } from './resolve.ts';
import { tryDirectDownload } from './probe.ts';
import { captureViewerSession, fetchViewerMeta } from './viewer.ts';
import { capturePages } from './capture.ts';
import { assemblePdf } from './assemble.ts';
import { verifyRun } from './verify.ts';
import type { CapturedPage, RunOptions, VerifyReport } from './types.ts';

/**
 * The extraction flow itself, with progress reported through a callback rather than
 * printed.
 *
 * This exists so the CLI and the browser UI cannot drift apart. Both are thin shells over
 * this function: the CLI turns events into terminal output, the server turns the same
 * events into SSE frames. A bug fixed here is fixed in both, and neither can quietly grow
 * its own slightly-different ordering of the stages.
 */

export type ExtractEvent =
  | { type: 'status'; message: string }
  | { type: 'resolved'; fileId: string }
  | { type: 'document'; title: string; pages: number; maxPageWidth: number; renderWidth: number }
  | { type: 'progress'; done: number; total: number }
  | { type: 'assembling' };

export interface ExtractResult {
  pdfBytes: Uint8Array;
  /** Sanitised document title, without extension. */
  title: string;
  /** True when Drive served the original file and no pages were rendered. */
  fastPath: boolean;
  pageCount: number;
  /** Null on the fast path: there are no captured pages to verify. */
  report: VerifyReport | null;
  /** Retained only so the CLI can honour --keep-pages. Null on the fast path. */
  pages: CapturedPage[] | null;
}

export async function extract(
  url: string,
  options: RunOptions,
  onEvent: (event: ExtractEvent) => void = () => {},
): Promise<ExtractResult> {
  const target = resolveTarget(url);

  if (target.kind === 'folder') {
    throw new Error(
      'Folder links are not supported. Open the folder in Drive, pick the document you want, ' +
        'and use that individual file link (https://drive.google.com/file/d/<id>/view).',
    );
  }

  onEvent({ type: 'resolved', fileId: target.fileId });

  // Always tried first: when Drive still serves the original, that file has real text and
  // vectors and is a fraction of the size of anything we can rebuild from page rasters.
  onEvent({ type: 'status', message: 'Trying direct download...' });
  const direct = await tryDirectDownload(target.fileId);
  if (direct) {
    onEvent({ type: 'status', message: 'Drive served the original PDF - no pages rendered.' });
    return {
      pdfBytes: direct,
      title: target.fileId,
      fastPath: true,
      pageCount: 0,
      report: null,
      pages: null,
    };
  }

  onEvent({ type: 'status', message: 'View-only. Capturing viewer token...' });
  const session = await captureViewerSession(target);
  const meta = await fetchViewerMeta(session);

  const renderWidth = Math.min(options.width, meta.maxPageWidth);
  onEvent({
    type: 'document',
    title: session.title,
    pages: meta.pages,
    maxPageWidth: meta.maxPageWidth,
    renderWidth,
  });

  const pages = await capturePages(session, meta, options, (done, total) =>
    onEvent({ type: 'progress', done, total }),
  );

  onEvent({ type: 'assembling' });
  const pdfBytes = await assemblePdf(pages);
  const report = verifyRun(pages, meta, pdfBytes);

  return {
    pdfBytes,
    title: session.title,
    fastPath: false,
    pageCount: report.actualPages,
    report,
    pages,
  };
}

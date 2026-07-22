import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { extract } from './pipeline.ts';
import type { CapturedPage, RunOptions } from './types.ts';

/**
 * Entry point for the Drive view-only PDF extractor.
 *
 * The ordering of the flow is the point of this module. A direct download, when Drive
 * allows it, produces the publisher's own PDF - text, vectors, a few hundred KB - and is
 * strictly better than anything we can rebuild from page rasters, so it is always
 * attempted first and the slow path only runs when it fails.
 *
 * The other deliberate decision is what happens when verification fails: the PDF is still
 * written, but under a `.partial.pdf` name and with a non-zero exit code. A silently
 * truncated or half-blank document that reports success is worse than no document at all,
 * because the person who asked for it will not notice until much later.
 */

const DEFAULTS = {
  width: 1600,
  quality: 82,
  concurrency: 8,
  outDir: 'output',
} as const;

const HELP = `
drive-pdf - rebuild a view-only Google Drive document as a local PDF

  npx tsx src/cli.ts <drive-url> [flags]

Flags
  --width=<px>        Render width per page. Default ${DEFAULTS.width}.
                      Clamped to the document's maxPageWidth (usually 3200).
  --quality=<1-100>   JPEG quality for re-encoded pages. Default ${DEFAULTS.quality}.
  --png               Embed the original lossless PNG instead of JPEG.
                      WARNING: ~930 KB/page at w=1600; a 159-page deck is ~148 MB.
  --concurrency=<n>   Parallel page fetches. Default ${DEFAULTS.concurrency}.
  --out=<dir>         Output directory. Default '${DEFAULTS.outDir}'.
  --keep-pages        Also write each page image to work/<fileId>/.
  --help              Show this message.

Example
  npx tsx src/cli.ts "https://drive.google.com/file/d/<id>/view" --width=1600

Only extract documents you are permitted to retain.
`;

interface CliArgs {
  url: string;
  options: RunOptions;
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${flag} must be a whole number between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

/** Returns null when the run should stop after printing help. */
function parseCliArgs(argv: string[]): CliArgs | null {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      width: { type: 'string' },
      quality: { type: 'string' },
      png: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      out: { type: 'string' },
      'keep-pages': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return null;
  }

  const url = positionals[0];
  if (!url) {
    throw new Error('No Drive URL given. Run with --help for usage.');
  }
  if (positionals.length > 1) {
    throw new Error(
      `Expected one URL but got ${positionals.length}. Quote the URL - Drive links contain characters your shell will split on.`,
    );
  }

  const quality = values.quality ? parseInteger(values.quality, 'quality', 1, 100) : DEFAULTS.quality;
  if (values.png && values.quality) {
    process.stdout.write('Note: --quality is ignored because --png embeds the original lossless image.\n');
  }

  return {
    url,
    options: {
      width: values.width ? parseInteger(values.width, 'width', 1, 10000) : DEFAULTS.width,
      jpegQuality: values.png ? null : quality,
      concurrency: values.concurrency
        ? parseInteger(values.concurrency, 'concurrency', 1, 64)
        : DEFAULTS.concurrency,
      outDir: values.out ?? DEFAULTS.outDir,
      keepPages: values['keep-pages'],
    },
  };
}

/** Windows rejects these outright, and a viewer-supplied title is not to be trusted as a path. */
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*/\\\u0000-\u001f]/g;

function safeFileName(title: string): string {
  const cleaned = title
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot produces a file Explorer can neither open nor delete.
    .replace(/\.+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'drive-document';
}

/**
 * Resolve a free path, suffixing " (2)", " (3)" and so on.
 * Overwriting is never the right default here: re-running with different flags is the
 * normal way to use this tool, and clobbering the previous attempt makes the two
 * impossible to compare.
 */
function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

function writePdf(dir: string, base: string, ext: string, bytes: Uint8Array): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = uniquePath(dir, base, ext);
  fs.writeFileSync(target, bytes);
  return path.resolve(target);
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Single-line progress. Falls back to periodic full lines when stdout is not a terminal,
 * because carriage returns in a redirected log or a CI transcript produce one long smear.
 */
function makeProgressReporter(): (done: number, total: number) => void {
  const isTty = process.stdout.isTTY === true;
  let lastDecile = -1;

  return (done, total) => {
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    if (isTty) {
      process.stdout.write(`\r  pages ${done}/${total} (${pct}%)   `);
      if (done >= total) process.stdout.write('\n');
      return;
    }
    const decile = Math.floor(pct / 10);
    if (decile > lastDecile || done >= total) {
      lastDecile = decile;
      process.stdout.write(`  pages ${done}/${total} (${pct}%)\n`);
    }
  };
}

function writePageImages(fileId: string, pages: CapturedPage[]): string {
  const dir = path.resolve('work', fileId);
  fs.mkdirSync(dir, { recursive: true });
  // Zero-padded so a directory listing sorts in page order.
  const pad = String(pages.length).length;
  for (const page of pages) {
    const ext = page.format === 'jpeg' ? 'jpg' : 'png';
    fs.writeFileSync(path.join(dir, `page-${String(page.index).padStart(pad, '0')}.${ext}`), page.bytes);
  }
  return dir;
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) return;
  const { url, options } = parsed;

  const progress = makeProgressReporter();
  let fileId = '';

  // The flow itself lives in pipeline.ts so the browser UI runs exactly the same stages.
  // This callback is only presentation.
  const result = await extract(url, options, (event) => {
    switch (event.type) {
      case 'resolved':
        fileId = event.fileId;
        process.stdout.write(`File ID: ${event.fileId}\n`);
        break;
      case 'status':
        process.stdout.write(`${event.message}\n`);
        break;
      case 'document':
        process.stdout.write(
          `Document: ${event.title}\n` +
            `  ${event.pages} pages, max render width ${event.maxPageWidth}px\n` +
            `  rendering at ${event.renderWidth}px as ` +
            `${options.jpegQuality === null ? 'lossless PNG' : `JPEG q${options.jpegQuality}`}, ` +
            `${options.concurrency} at a time\n`,
        );
        if (options.jpegQuality === null) {
          process.stdout.write(
            'WARNING: --png embeds lossless images. Expect a very large PDF (~930 KB per page at w=1600).\n',
          );
        }
        break;
      case 'progress':
        progress(event.done, event.total);
        break;
      case 'assembling':
        process.stdout.write('Assembling PDF...\n');
        break;
    }
  });

  if (result.fastPath) {
    const written = writePdf(options.outDir, result.title, '.pdf', result.pdfBytes);
    process.stdout.write(
      '\nFast path succeeded - Drive served the original PDF, so no pages were rendered.\n' +
        `  ${written}\n  ${megabytes(result.pdfBytes.byteLength)}\n`,
    );
    return;
  }

  if (options.keepPages && result.pages) {
    process.stdout.write(`Page images kept in ${writePageImages(fileId, result.pages)}\n`);
  }

  const { pdfBytes } = result;
  // Non-null on the render path; only the fast path returns without a report, and that
  // returned above.
  const report = result.report!;
  const base = safeFileName(result.title);

  if (!report.ok) {
    for (const problem of report.problems) {
      process.stdout.write(`  PROBLEM: ${problem}\n`);
    }
    if (report.blankPages.length > 0) {
      process.stdout.write(`  Blank pages (0-based): ${report.blankPages.join(', ')}\n`);
    }
    for (const group of report.duplicateGroups) {
      process.stdout.write(`  Identical pages (0-based): ${group.join(', ')}\n`);
    }
    const written = writePdf(options.outDir, base, '.partial.pdf', pdfBytes);
    process.stdout.write(
      '\nVerification FAILED - the file was written anyway so you can inspect it:\n' +
        `  ${written}\n` +
        `  ${report.actualPages}/${report.expectedPages} pages, ${megabytes(report.bytes)}\n` +
        'Re-run to retry; an expired viewer token is the usual cause.\n',
    );
    process.exitCode = 1;
    return;
  }

  const written = writePdf(options.outDir, base, '.pdf', pdfBytes);
  process.stdout.write(
    `\nDone.\n  ${written}\n  ${report.actualPages} pages, ${megabytes(report.bytes)}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // A raw stack is noise for the QA engineer running this; keep it behind DEBUG.
  process.stderr.write(`\nError: ${message}\n`);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  } else {
    process.stderr.write('Set DEBUG=1 for the full stack trace.\n');
  }
  process.exitCode = 1;
});

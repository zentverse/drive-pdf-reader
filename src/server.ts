import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extract } from './pipeline.ts';
import type { RunOptions, VerifyReport } from './types.ts';

/**
 * Local web UI.
 *
 * The whole reason this exists rather than a `--out` flag is the save dialog: the browser
 * can open a real native "Save As" window through showSaveFilePicker, so the finished PDF
 * lands wherever the user points it. Node cannot open that dialog without dragging in
 * Electron or a native module, and the browser already has one.
 *
 * Consequently the server never writes a PDF to disk. It holds the bytes in memory under a
 * job id and hands them to the page, which owns the save. Jobs expire so a long-running
 * server does not accumulate hundreds of megabytes of forgotten documents.
 *
 * Bound to 127.0.0.1 only. This drives a headless browser and fetches arbitrary URLs on
 * request; it has no business being reachable from the network.
 */

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5174;

/** Long enough to pick a folder without thinking, short enough to bound memory. */
const JOB_TTL_MS = 30 * 60_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Job {
  bytes: Uint8Array;
  filename: string;
  createdAt: number;
}

const jobs = new Map<string, Job>();

function reapExpiredJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

/** Mirrors cli.ts's safeFileName; the download name must survive the same OS rules. */
function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[<>:"|?*/\\\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'drive-document';
}

function optionsFromQuery(params: URLSearchParams): RunOptions {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
    }
    return value;
  };

  const png = params.get('png') === 'true';
  return {
    width: int('width', 1600, 1, 10000),
    jpegQuality: png ? null : int('quality', 82, 1, 100),
    concurrency: int('concurrency', 8, 1, 64),
    // The browser owns the save, so nothing is written server-side.
    outDir: '',
    keepPages: false,
  };
}

function sseSend(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleExtract(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const target = url.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No Drive URL supplied.' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // The pipeline has no cancellation hook, so a disconnect stops the stream rather than the
  // work. Noted so a half-finished run cannot be mistaken for a hung server.
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });

  try {
    const options = optionsFromQuery(url.searchParams);
    const result = await extract(target, options, (event) => {
      if (!clientGone) sseSend(res, event);
    });

    reapExpiredJobs();
    const id = crypto.randomUUID();
    const report: VerifyReport | null = result.report;
    const suffix = report && !report.ok ? '.partial.pdf' : '.pdf';
    const filename = `${safeFileName(result.title)}${suffix}`;

    jobs.set(id, { bytes: result.pdfBytes, filename, createdAt: Date.now() });

    sseSend(res, {
      type: 'done',
      jobId: id,
      filename,
      bytes: result.pdfBytes.byteLength,
      pageCount: result.fastPath ? null : result.pageCount,
      fastPath: result.fastPath,
      ok: report ? report.ok : true,
      problems: report ? report.problems : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!clientGone) sseSend(res, { type: 'error', message });
  } finally {
    res.end();
  }
}

function handleFile(res: http.ServerResponse, id: string): void {
  const job = jobs.get(id);
  if (!job) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Job not found or expired. Run the extraction again.');
    return;
  }
  // RFC 6266: a plain ASCII `filename` for old clients plus a UTF-8 `filename*` for the
  // real name. Percent-encoding the plain form instead would show the user literal %20s.
  const ascii = job.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': String(job.bytes.byteLength),
    'content-disposition':
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
  });
  res.end(Buffer.from(job.bytes));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);

  if (url.pathname === '/') {
    // Read per request so editing the UI needs no restart.
    fs.readFile(path.join(HERE, 'ui.html'), (err, html) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('ui.html is missing from src/.');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  if (url.pathname === '/api/extract') {
    void handleExtract(req, res, url);
    return;
  }

  if (url.pathname.startsWith('/api/file/')) {
    handleFile(res, url.pathname.slice('/api/file/'.length));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

function openBrowser(target: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Opening a browser is a convenience; the printed URL is the real interface.
  }
}

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1] ?? process.env.PORT ?? DEFAULT_PORT);

server.listen(port, HOST, () => {
  const address = `http://${HOST}:${port}`;
  process.stdout.write(`\ndrive-pdf-reader UI running at ${address}\n  Ctrl+C to stop.\n\n`);
  openBrowser(address);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `\nPort ${port} is already in use. Start it on another port:\n` +
        `  npm run ui -- --port=${port + 1}\n\n`,
    );
    process.exitCode = 1;
    return;
  }
  throw error;
});

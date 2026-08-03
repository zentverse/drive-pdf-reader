import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { extract } from './pipeline.ts';
import { extractVideoSlidesBatch } from './video.ts';
import type { RunOptions, VerifyReport } from './types.ts';
import type { VideoOptions } from './video.ts';

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
const UPLOAD_TTL_MS = 60 * 60_000;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024 * 1024;

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Job {
  bytes: Uint8Array;
  filename: string;
  createdAt: number;
}

interface VideoUpload {
  directory: string;
  filePath: string;
  filename: string;
  bytes: number;
  createdAt: number;
  active: boolean;
}

const jobs = new Map<string, Job>();
const videoUploads = new Map<string, VideoUpload>();

// Handles the narrow case where a browser closes after upload but before starting extraction.
const uploadReaper = setInterval(() => void reapExpiredUploads(), 15 * 60_000);
uploadReaper.unref();

function reapExpiredJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

async function reapExpiredUploads(): Promise<void> {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  const removals: Promise<void>[] = [];
  for (const [id, upload] of videoUploads) {
    if (upload.createdAt < cutoff && !upload.active) {
      videoUploads.delete(id);
      removals.push(fs.promises.rm(upload.directory, { recursive: true, force: true }));
    }
  }
  await Promise.all(removals);
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

function videoOptionsFromQuery(params: URLSearchParams): VideoOptions {
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${name} must be between ${min} and ${max} (got "${raw}").`);
    }
    return value;
  };

  return {
    sampleSeconds: number('sampleSeconds', 1, 0.25, 30),
    sensitivity: number('sensitivity', 7, 1, 10),
    maxWidth: Math.round(number('maxWidth', 1920, 320, 7680)),
    jpegQuality: Math.round(number('quality', 88, 40, 100)),
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

class UploadTooLargeError extends Error {}

function uploadFilename(raw: string | null): string {
  const cleaned = path
    .basename(raw ?? '')
    .replace(/[<>:"|?*\\/\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 200) || 'video';
}

async function handleVideoUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end(JSON.stringify({ error: 'Use POST to upload a video.' }));
    return;
  }

  const declaredBytes = Number(req.headers['content-length'] ?? 0);
  if (declaredBytes > MAX_VIDEO_BYTES) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Video is larger than the 10 GB local upload limit.' }));
    return;
  }

  await reapExpiredUploads();
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drive-pdf-upload-'));
  const filePath = path.join(directory, 'upload.video');
  let bytes = 0;

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_VIDEO_BYTES) {
        callback(new UploadTooLargeError('Video is larger than the 10 GB local upload limit.'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await streamPipeline(req, limiter, fs.createWriteStream(filePath, { flags: 'wx' }));
    if (bytes === 0) throw new Error('The uploaded file is empty.');

    const id = crypto.randomUUID();
    const filename = uploadFilename(url.searchParams.get('filename'));
    videoUploads.set(id, {
      directory,
      filePath,
      filename,
      bytes,
      createdAt: Date.now(),
      active: false,
    });

    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ uploadId: id, filename, bytes }));
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    const status = error instanceof UploadTooLargeError ? 413 : 400;
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }
}

async function handleVideoExtract(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const uploadIds = url.searchParams.getAll('uploadId');
  if (uploadIds.length === 0) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No video uploads were supplied.' }));
    return;
  }
  if (new Set(uploadIds).size !== uploadIds.length) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The same video upload was supplied more than once.' }));
    return;
  }

  const uploads = uploadIds.map((id) => videoUploads.get(id));
  if (uploads.some((upload) => !upload)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'One or more video uploads were not found or expired. Upload them again.' }));
    return;
  }
  const readyUploads = uploads.filter((upload): upload is VideoUpload => Boolean(upload));
  if (readyUploads.some((upload) => upload.active)) {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'One of these videos is already being processed.' }));
    return;
  }

  let options: VideoOptions;
  try {
    options = videoOptionsFromQuery(url.searchParams);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
    return;
  }

  for (const upload of readyUploads) upload.active = true;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });

  try {
    const result = await extractVideoSlidesBatch(
      readyUploads.map((upload) => ({ inputPath: upload.filePath, filename: upload.filename })),
      options,
      (event) => {
        if (!clientGone) sseSend(res, event);
      },
    );

    reapExpiredJobs();
    const id = crypto.randomUUID();
    const filename =
      result.fileCount === 1
        ? `${safeFileName(result.title)} - unique frames.pdf`
        : 'Combined video frames.pdf';
    jobs.set(id, { bytes: result.pdfBytes, filename, createdAt: Date.now() });

    if (!clientGone) {
      sseSend(res, {
        type: 'done',
        kind: 'video',
        jobId: id,
        filename,
        bytes: result.pdfBytes.byteLength,
        pageCount: result.uniqueFrames,
        sampledFrames: result.sampledFrames,
        durationSeconds: result.durationSeconds,
        fileCount: result.fileCount,
        files: result.files,
        ok: true,
        problems: [],
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!clientGone) sseSend(res, { type: 'error', message });
  } finally {
    for (const uploadId of uploadIds) videoUploads.delete(uploadId);
    await Promise.all(
      readyUploads.map((upload) => fs.promises.rm(upload.directory, { recursive: true, force: true })),
    );
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

  if (url.pathname === '/api/video/upload') {
    void handleVideoUpload(req, res, url);
    return;
  }

  if (url.pathname === '/api/video/extract') {
    void handleVideoExtract(req, res, url);
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

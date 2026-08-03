import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';

import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';

import { assemblePdf } from './assemble.ts';
import type { CapturedPage } from './types.ts';

/**
 * Presentation-oriented video extraction.
 *
 * The video is sampled at a configurable interval, then every sample is reduced to a
 * small perceptual signature. A frame is kept only when it is visually distinct from
 * every frame already accepted. Comparing against the entire accepted set (rather than
 * only the previous frame) removes slides that are revisited later in a recording.
 */

export interface VideoOptions {
  /** Seconds between sampled frames. Smaller values catch short-lived slides. */
  sampleSeconds: number;
  /** 1 keeps fewer near-identical frames; 10 preserves subtler changes. */
  sensitivity: number;
  /** Frames are downscaled to this width but are never enlarged. */
  maxWidth: number;
  jpegQuality: number;
}

export interface VideoInput {
  inputPath: string;
  filename: string;
}

interface VideoEventContext {
  /** 0-based position in the selected batch. */
  fileIndex: number;
  fileCount: number;
  filename: string;
}

export type VideoEvent =
  | ({ type: 'video-status'; message: string } & Partial<VideoEventContext>)
  | ({
      type: 'video-progress';
      stage: 'decoding';
      percent: number | null;
      seconds: number;
      durationSeconds: number | null;
    } & Partial<VideoEventContext>)
  | ({
      type: 'video-progress';
      stage: 'analyzing';
      done: number;
      total: number;
      unique: number;
      uniqueInFile: number;
    } & Partial<VideoEventContext>)
  | { type: 'video-assembling'; pages: number; fileCount: number };

export interface VideoFileResult {
  filename: string;
  sampledFrames: number;
  uniqueFramesAdded: number;
  durationSeconds: number | null;
}

export interface VideoResult {
  pdfBytes: Uint8Array;
  title: string;
  sampledFrames: number;
  uniqueFrames: number;
  durationSeconds: number | null;
  fileCount: number;
  files: VideoFileResult[];
}

interface FrameSignature {
  hash: Uint32Array;
  pixels: Uint8Array;
}

interface AcceptedFrame {
  signature: FrameSignature;
  page: CapturedPage;
}

const HASH_WIDTH = 16;
const HASH_HEIGHT = 16;
const THUMB_WIDTH = HASH_WIDTH + 1;
const THUMB_HEIGHT = HASH_HEIGHT;

function parseTimestamp(value: string): number {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function popcount32(value: number): number {
  let n = value >>> 0;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function makeSignature(pixels: Uint8Array): FrameSignature {
  const hash = new Uint32Array((HASH_WIDTH * HASH_HEIGHT) / 32);
  let bit = 0;

  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    const row = y * THUMB_WIDTH;
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      if (pixels[row + x] > pixels[row + x + 1]) {
        hash[bit >>> 5] |= (1 << (bit & 31)) >>> 0;
      }
      bit += 1;
    }
  }

  return { hash, pixels };
}

function hashDistance(a: Uint32Array, b: Uint32Array): number {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    distance += popcount32(a[i] ^ b[i]);
  }
  return distance;
}

function pixelDifferencePercent(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return (total / (a.length * 255)) * 100;
}

/** Exported for deterministic algorithm tests without invoking FFmpeg. */
export function signaturesMatch(
  a: FrameSignature,
  b: FrameSignature,
  sensitivity: number,
): boolean {
  const clamped = Math.max(1, Math.min(10, sensitivity));
  // Higher sensitivity tightens both tolerances, so small visual changes survive.
  const maxHashDistance = Math.round(16 - clamped);
  const maxPixelDifference = 3.3 - clamped * 0.22;
  return (
    hashDistance(a.hash, b.hash) <= maxHashDistance &&
    pixelDifferencePercent(a.pixels, b.pixels) <= maxPixelDifference
  );
}

async function signatureFor(file: string): Promise<FrameSignature> {
  const pixels = await sharp(file)
    .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  return makeSignature(new Uint8Array(pixels));
}

function ffmpegErrorMessage(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.filter(
    (line) =>
      !line.startsWith('ffmpeg version') &&
      !line.startsWith('built with') &&
      !line.startsWith('configuration:') &&
      !line.startsWith('lib'),
  );
  return (useful.slice(-6).join(' ') || 'FFmpeg could not decode the uploaded file.').slice(0, 1200);
}

async function decodeSamples(
  inputPath: string,
  frameDir: string,
  options: VideoOptions,
  onEvent: (event: VideoEvent) => void,
): Promise<number | null> {
  const executable = ffmpegPath;
  if (!executable) {
    throw new Error('The bundled FFmpeg binary is unavailable. Re-run npm install and try again.');
  }

  const outputPattern = path.join(frameDir, 'frame-%08d.jpg');
  const videoFilter =
    `fps=1/${options.sampleSeconds},` +
    `scale='min(${options.maxWidth},iw)':-2`;
  const args = [
    '-nostdin',
    '-hide_banner',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    videoFilter,
    '-q:v',
    '2',
    '-fps_mode',
    'vfr',
    '-y',
    outputPattern,
  ];

  return await new Promise<number | null>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'] as const,
    });
    let stderr = '';
    let durationSeconds: number | null = null;
    let lastPercent = -1;

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-24_000);

      const durationMatch = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(stderr);
      if (durationMatch) durationSeconds = parseTimestamp(durationMatch[1]);

      const times = [...text.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
      const lastTime = times.at(-1);
      if (!lastTime) return;

      const seconds = parseTimestamp(lastTime[1]);
      const percent = durationSeconds
        ? Math.max(0, Math.min(100, Math.round((seconds / durationSeconds) * 100)))
        : null;
      if (percent === null || percent >= lastPercent + 2) {
        if (percent !== null) lastPercent = percent;
        onEvent({ type: 'video-progress', stage: 'decoding', percent, seconds, durationSeconds });
      }
    });

    child.once('error', (error) => reject(new Error(`Could not start FFmpeg: ${error.message}`)));
    child.once('close', (code) => {
      if (code === 0) {
        onEvent({
          type: 'video-progress',
          stage: 'decoding',
          percent: 100,
          seconds: durationSeconds ?? 0,
          durationSeconds,
        });
        resolve(durationSeconds);
        return;
      }
      reject(new Error(ffmpegErrorMessage(stderr)));
    });
  });
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '').trim();
  return withoutExtension || 'video';
}

export async function extractVideoSlides(
  inputPath: string,
  filename: string,
  options: VideoOptions,
  onEvent: (event: VideoEvent) => void = () => {},
): Promise<VideoResult> {
  return await extractVideoSlidesBatch([{ inputPath, filename }], options, onEvent);
}

export async function extractVideoSlidesBatch(
  inputs: VideoInput[],
  options: VideoOptions,
  onEvent: (event: VideoEvent) => void = () => {},
): Promise<VideoResult> {
  if (inputs.length === 0) throw new Error('Choose at least one video file.');

  const batchFrameDir = await mkdtemp(path.join(os.tmpdir(), 'drive-pdf-video-frames-'));

  try {
    const accepted: AcceptedFrame[] = [];
    const files: VideoFileResult[] = [];
    let sampledFrames = 0;

    for (let fileIndex = 0; fileIndex < inputs.length; fileIndex += 1) {
      const input = inputs[fileIndex];
      const frameDir = path.join(batchFrameDir, String(fileIndex).padStart(4, '0'));
      await mkdir(frameDir);

      const withContext = (event: VideoEvent): void => {
        onEvent({
          ...event,
          fileIndex,
          fileCount: inputs.length,
          filename: input.filename,
        } as VideoEvent);
      };

      withContext({
        type: 'video-status',
        message: `Decoding video ${fileIndex + 1} of ${inputs.length}: ${input.filename}`,
      });
      const durationSeconds = await decodeSamples(input.inputPath, frameDir, options, withContext);
      const frameFiles = (await readdir(frameDir))
        .filter((name) => /^frame-\d{8}\.jpg$/i.test(name))
        .sort();

      if (frameFiles.length === 0) {
        throw new Error(
          `No video frames were found in "${input.filename}". ` +
            'The file may be audio-only or use an unsupported codec.',
        );
      }

      sampledFrames += frameFiles.length;
      const uniqueBeforeFile = accepted.length;
      withContext({
        type: 'video-status',
        message: `Finding unique slides in video ${fileIndex + 1} of ${inputs.length}...`,
      });

      for (let index = 0; index < frameFiles.length; index += 1) {
        const framePath = path.join(frameDir, frameFiles[index]);
        const signature = await signatureFor(framePath);
        const duplicate = accepted.some((candidate) =>
          signaturesMatch(signature, candidate.signature, options.sensitivity),
        );

        if (!duplicate) {
          const encoded = await sharp(framePath)
            .jpeg({ quality: options.jpegQuality, mozjpeg: true })
            .toBuffer({ resolveWithObject: true });
          const width = encoded.info.width;
          const height = encoded.info.height;
          if (!width || !height) throw new Error(`Could not read dimensions for ${frameFiles[index]}.`);

          accepted.push({
            signature,
            page: {
              index: accepted.length,
              bytes: new Uint8Array(encoded.data),
              format: 'jpeg',
              width,
              height,
            },
          });
        }

        if (index === 0 || (index + 1) % 5 === 0 || index + 1 === frameFiles.length) {
          withContext({
            type: 'video-progress',
            stage: 'analyzing',
            done: index + 1,
            total: frameFiles.length,
            unique: accepted.length,
            uniqueInFile: accepted.length - uniqueBeforeFile,
          });
        }
      }

      files.push({
        filename: input.filename,
        sampledFrames: frameFiles.length,
        uniqueFramesAdded: accepted.length - uniqueBeforeFile,
        durationSeconds,
      });
    }

    if (accepted.length === 0) throw new Error('The selected videos did not contain any usable frames.');

    onEvent({ type: 'video-assembling', pages: accepted.length, fileCount: inputs.length });
    const title = inputs.length === 1 ? titleFromFilename(inputs[0].filename) : 'Combined video frames';
    const pdfBytes = await assemblePdf(
      accepted.map((frame) => frame.page),
      { title: `${title} - unique frames`, producer: 'drive-pdf-reader video-to-pdf' },
    );

    const allDurationsKnown = files.every((file) => file.durationSeconds !== null);
    const durationSeconds = allDurationsKnown
      ? files.reduce((total, file) => total + (file.durationSeconds ?? 0), 0)
      : null;

    return {
      pdfBytes,
      title,
      sampledFrames,
      uniqueFrames: accepted.length,
      durationSeconds,
      fileCount: inputs.length,
      files,
    };
  } finally {
    await rm(batchFrameDir, { recursive: true, force: true });
  }
}

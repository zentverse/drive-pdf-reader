import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';

import ffmpegPath from 'ffmpeg-static';
import { PDFDocument } from 'pdf-lib';

import { extractVideoSlides, extractVideoSlidesBatch } from './video.ts';

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with ${code}: ${stderr}`));
    });
  });
}

async function generateColorVideo(command: string, outputPath: string, colors: string[]): Promise<void> {
  const inputs = colors.flatMap((color) => [
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=640x360:d=1.5`,
  ]);
  const concatInputs = colors.map((_, index) => `[${index}:v]`).join('');
  await run(command, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    `${concatInputs}concat=n=${colors.length}:v=1:a=0,fps=10[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-y',
    outputPath,
  ]);
}

test('video extraction removes a repeated scene and builds one PDF page per unique scene', async () => {
  assert.ok(ffmpegPath, 'ffmpeg-static did not provide a binary');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'drive-pdf-video-test-'));
  const videoPath = path.join(directory, 'presentation.mp4');

  try {
    await generateColorVideo(ffmpegPath, videoPath, [
      '0x1d4ed8',
      '0xdc2626',
      '0x1d4ed8',
      '0x16a34a',
    ]);

    const result = await extractVideoSlides(videoPath, 'presentation.mp4', {
      sampleSeconds: 0.5,
      sensitivity: 7,
      maxWidth: 1280,
      jpegQuality: 85,
    });
    const pdf = await PDFDocument.load(result.pdfBytes);

    assert.equal(result.uniqueFrames, 3);
    assert.equal(pdf.getPageCount(), 3);
    assert.ok(result.sampledFrames >= 10);
    assert.ok(result.pdfBytes.byteLength > 1_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('multiple videos are combined in order and deduplicated across file boundaries', async () => {
  assert.ok(ffmpegPath, 'ffmpeg-static did not provide a binary');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'drive-pdf-video-batch-test-'));
  const firstPath = path.join(directory, 'part-one.mp4');
  const secondPath = path.join(directory, 'part-two.mp4');

  try {
    await generateColorVideo(ffmpegPath, firstPath, ['0x1d4ed8', '0xdc2626']);
    await generateColorVideo(ffmpegPath, secondPath, ['0xdc2626', '0x16a34a']);

    const result = await extractVideoSlidesBatch(
      [
        { inputPath: firstPath, filename: 'part-one.mp4' },
        { inputPath: secondPath, filename: 'part-two.mp4' },
      ],
      {
        sampleSeconds: 0.5,
        sensitivity: 7,
        maxWidth: 1280,
        jpegQuality: 85,
      },
    );
    const pdf = await PDFDocument.load(result.pdfBytes);

    assert.equal(result.fileCount, 2);
    assert.equal(result.uniqueFrames, 3);
    assert.equal(result.files[0].uniqueFramesAdded, 2);
    assert.equal(result.files[1].uniqueFramesAdded, 1);
    assert.equal(pdf.getPageCount(), 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

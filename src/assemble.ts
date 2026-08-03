import { PDFDocument } from 'pdf-lib';
import type { CapturedPage } from './types.ts';

/**
 * Assembly stage: rendered page images -> a single PDF.
 *
 * Two constraints shape this module.
 *
 * First, pdf-lib can embed JPEG and PNG and nothing else. The viewer will happily serve
 * WebP (&webp=true) and it is much smaller on the wire, but a WebP buffer handed to
 * embedPng/embedJpg corrupts the document rather than failing loudly, so the capture
 * stage must have already transcoded to one of the two supported formats and said so in
 * CapturedPage.format. We only trust that field.
 *
 * Second, page geometry is decided per page, not once for the document. PDF user space is
 * 72 units to the inch, so treating one rendered pixel as one point makes each PDF page
 * exactly the size of its own image and keeps the embed a 1:1 draw with no resampling. A
 * deck with a landscape body and a portrait appendix would be letterboxed or cropped by a
 * single global page box, so each page gets its own.
 */

const PDF_PRODUCER = 'drive-pdf (tools/drive-pdf)' as const;

export interface PdfMetadata {
  title?: string;
  producer?: string;
}

export async function assemblePdf(
  pages: CapturedPage[],
  metadata: PdfMetadata = {},
): Promise<Uint8Array> {
  if (pages.length === 0) {
    throw new Error('assemblePdf: no pages to assemble - the capture stage returned an empty set.');
  }

  // The capture stage runs fetches concurrently, so arrival order is not page order.
  const ordered = [...pages].sort((a, b) => a.index - b.index);

  const doc = await PDFDocument.create();
  doc.setTitle(metadata.title ?? 'Drive document');
  doc.setProducer(metadata.producer ?? PDF_PRODUCER);
  doc.setCreator(metadata.producer ?? PDF_PRODUCER);
  doc.setCreationDate(new Date());

  for (const page of ordered) {
    const image =
      page.format === 'jpeg'
        ? await doc.embedJpg(page.bytes)
        : await doc.embedPng(page.bytes);

    const pdfPage = doc.addPage([page.width, page.height]);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
    });
  }

  return await doc.save();
}

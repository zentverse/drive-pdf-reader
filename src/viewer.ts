import { chromium, type Page } from 'playwright';
import type { ResolvedTarget, ViewerMeta, ViewerSession } from './types.ts';

/**
 * Viewer session capture and document metadata.
 *
 * This is the only stage in the pipeline that needs a real browser. The Drive viewer mints
 * an opaque `ACFrOgB...` token per session and stamps it on every /viewer/* request; that
 * token is all the downstream stages need, and it is honoured with credentials omitted.
 * So the browser is paid for exactly once, here, and what leaves this module is plain data.
 *
 * The token is scraped from outbound request URLs rather than from the DOM because the
 * viewer never puts it in markup - it exists only in query strings its own scripts build.
 */

const VIEWER_ORIGIN = 'https://drive.google.com';

/** Only these three viewer endpoints carry the token, and they all carry it as `id`. */
const TOKEN_BEARING_REQUEST = /\/viewer\/(meta|img|presspage)\?/;

/** The viewer normally fires /viewer/meta within a second; 45s is a stall, not slowness. */
const TOKEN_TIMEOUT_MS = 45_000;

/** NTFS tolerates 255, but long names break tooling downstream long before that. */
const MAX_TITLE_LENGTH = 120;

const SIGN_IN_ORIGIN = 'https://accounts.google.com';

export async function captureViewerSession(target: ResolvedTarget): Promise<ViewerSession> {
  if (target.kind !== 'file') {
    throw new Error(
      `Cannot open a viewer session for a ${target.kind}: ${target.sourceUrl}. Only single files have a viewer.`,
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    let resolveToken: ((viewerId: string) => void) | undefined;
    let rejectToken: ((err: Error) => void) | undefined;
    const tokenSeen = new Promise<string>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    // Attached before navigation on purpose: the first token-bearing request goes out
    // within milliseconds of the document committing, and there is no replay of it.
    page.on('request', (request) => {
      const url = request.url();
      if (!TOKEN_BEARING_REQUEST.test(url)) return;
      const id = new URL(url).searchParams.get('id');
      if (id) resolveToken?.(id);
    });

    // A redirect to the sign-in page never produces a token, so fail loudly instead of
    // sitting out the full timeout waiting for a request that will never be made.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (frame.url().startsWith(SIGN_IN_ORIGIN)) {
        rejectToken?.(
          new Error(
            `Drive redirected ${target.sourceUrl} to a Google sign-in page. This file is not publicly viewable: ` +
              'it needs a signed-in session, which this tool deliberately does not create.',
          ),
        );
      }
    });

    const viewUrl = `${VIEWER_ORIGIN}/file/d/${target.fileId}/view`;
    // `commit` rather than `load`: the viewer keeps streaming tiles for the whole document,
    // so waiting for load would add tens of seconds after the token is already in hand.
    // Navigation errors are routed into the race instead of being awaited separately.
    void page
      .goto(viewUrl, { waitUntil: 'commit', timeout: TOKEN_TIMEOUT_MS })
      .catch((err: unknown) => rejectToken?.(asError(err)));

    const viewerId = await withTimeout(
      tokenSeen,
      TOKEN_TIMEOUT_MS,
      `No viewer token appeared within ${TOKEN_TIMEOUT_MS / 1000}s at ${viewUrl}. ` +
        'The document may be unavailable, restricted, or the viewer markup may have changed.',
    );

    return { viewerId, title: await readTitle(page, target.fileId) };
  } finally {
    // Chromium outlives the process if this is skipped on the error path.
    await browser.close();
  }
}

export async function fetchViewerMeta(session: ViewerSession): Promise<ViewerMeta> {
  const url = new URL(`${VIEWER_ORIGIN}/viewer/meta`);
  url.searchParams.set('id', session.viewerId);
  url.searchParams.set('dsmi', 'texmex');
  url.searchParams.set('skipbookmarks', 'false');

  // The token authenticates on its own. Sending cookies would only risk binding the call
  // to whatever account happens to be around, which is the failure mode we are avoiding.
  const response = await fetch(url, { credentials: 'omit', headers: { accept: '*/*' } });
  if (!response.ok) {
    throw new Error(
      `/viewer/meta returned HTTP ${response.status} ${response.statusText}. ` +
        'The viewer token is short-lived; it has most likely expired and needs re-minting.',
    );
  }

  const body = await response.text();
  const json = stripXssiPrefix(body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `/viewer/meta did not return JSON after XSSI stripping. First 200 characters: ${json.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`/viewer/meta returned ${typeof parsed} where an object was expected.`);
  }

  const { pages, maxPageWidth } = parsed as Record<string, unknown>;
  if (!isPositiveInteger(pages)) {
    throw new Error(
      `/viewer/meta reported an unusable page count (${describe(pages)}); a positive integer was expected.`,
    );
  }
  if (!isPositiveInteger(maxPageWidth)) {
    throw new Error(
      `/viewer/meta reported an unusable maxPageWidth (${describe(maxPageWidth)}); a positive integer was expected.`,
    );
  }

  return { pages, maxPageWidth };
}

/**
 * Google guards its JSON endpoints with a `)]}'` line that is deliberately invalid JSON,
 * so JSON.parse must never see the first line.
 */
function stripXssiPrefix(body: string): string {
  const leading = body.trimStart();
  if (leading.startsWith('{') || leading.startsWith('[')) return leading;

  const firstNewline = body.indexOf('\n');
  return firstNewline === -1 ? body : body.slice(firstNewline + 1);
}

/**
 * The tab title is written by the viewer's own bootstrap, which can still be pending when
 * the first image request fires, so a short poll is cheaper than losing the real name.
 */
async function readTitle(page: Page, fallback: string): Promise<string> {
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = sanitiseFilename(await page.title());
      if (candidate && !/^google drive$/i.test(candidate)) return candidate;
      await page.waitForTimeout(250);
    }
  } catch {
    // The title is cosmetic - a closed page or a navigation mid-read must not fail a run.
  }
  return fallback;
}

function sanitiseFilename(raw: string): string {
  return (
    raw
      .replace(/\s*-\s*Google Drive\s*$/i, '')
      .replace(/\.pdf$/i, '')
      // Reserved on Win32 in any path component; control characters also break shells.
      .replace(/[<>:"/\\|?*]/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE_LENGTH)
      // Win32 silently drops trailing dots and spaces, which would make the path we report
      // differ from the path actually written.
      .replace(/[. ]+$/, '')
      .trim()
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function describe(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

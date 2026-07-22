import type { ResolvedTarget } from './types.ts';

/**
 * Turns whatever the user pasted into a file ID.
 *
 * Drive exposes the same document under a dozen URL shapes (/file/d/, /document/d/,
 * ?id=, bare IDs copied out of a share dialog) and decorates all of them with
 * ?usp=sharing and #heading noise. Every later stage needs only the ID, so the mess is
 * confined to this module and nothing downstream ever parses a URL again.
 */

/**
 * Drive IDs are base64url-ish. Real ones cluster at 28/33/44 characters, but Google has
 * changed the length over the years, so the bounds are deliberately loose: this is a
 * shape check to catch typos, not an authority on what IDs exist.
 */
const ID_FROM_URL = /^[A-Za-z0-9_-]{19,120}$/;

/**
 * A bare ID has no URL structure to corroborate it, so it needs a tighter floor —
 * otherwise an ordinary word typed by mistake would sail through as an ID.
 */
const BARE_ID = /^[A-Za-z0-9_-]{25,120}$/;

/** Path forms that carry the ID as a path segment. */
const DOC_PATH = /\/(?:file|document|presentation|spreadsheets|forms|drawings)\/d\/([^/?#]+)/;
const GENERIC_D_PATH = /\/d\/([^/?#]+)/;
const FOLDER_PATH = /\/folders\/([^/?#]+)/;
/** Published-to-web docs: /d/e/{publishId}/pub. The publish ID is not a file ID. */
const PUBLISHED_PATH = /\/d\/e\/([^/?#]+)/;

/** Query params Drive uses to carry an ID. */
const ID_PARAMS = ['id', 'docid', 'srcid'] as const;

const SUPPORTED_FORMS = [
  'https://drive.google.com/file/d/{id}/view',
  'https://drive.google.com/file/d/{id}/edit',
  'https://drive.google.com/open?id={id}',
  'https://drive.google.com/uc?id={id}',
  'https://docs.google.com/document/d/{id}/edit',
  'https://docs.google.com/presentation/d/{id}/edit',
  'https://docs.google.com/spreadsheets/d/{id}/edit',
  'https://drive.google.com/drive/folders/{id}',
  'https://drive.google.com/drive/u/0/folders/{id}',
  'a bare file ID on its own',
] as const;

function unsupported(sourceUrl: string, detail?: string): Error {
  const lead = detail ?? `Could not find a Drive file ID in ${JSON.stringify(sourceUrl)}.`;
  return new Error(`${lead}\nSupported forms:\n  ${SUPPORTED_FORMS.join('\n  ')}`);
}

/**
 * Accepts protocol-relative and protocol-less input, because that is what people get
 * when they copy a link out of a chat client. Returns null when the input has no URL
 * structure at all, which is the signal to treat it as a bare ID.
 */
function parseLoosely(raw: string): URL | null {
  if (!/[/:?#]/.test(raw)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, '')}`;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

export function resolveTarget(url: string): ResolvedTarget {
  const sourceUrl = url.trim();
  if (!sourceUrl) {
    throw unsupported(sourceUrl, 'No URL or file ID was supplied.');
  }

  const parsed = parseLoosely(sourceUrl);

  if (!parsed) {
    if (BARE_ID.test(sourceUrl)) {
      return { fileId: sourceUrl, kind: 'file', sourceUrl };
    }
    throw unsupported(sourceUrl);
  }

  const path = decodeURIComponent(parsed.pathname);

  // Folders first: /drive/folders/{id} also matches nothing else, but /drive/u/0/folders/{id}
  // would otherwise be mistaken for a path with a user-number segment.
  const folder = path.match(FOLDER_PATH)?.[1] ?? (isFolderView(parsed) ? paramId(parsed) : undefined);
  if (folder && ID_FROM_URL.test(folder)) {
    return { fileId: folder, kind: 'folder', sourceUrl };
  }

  const published = path.match(PUBLISHED_PATH)?.[1];
  if (published) {
    throw unsupported(
      sourceUrl,
      'That is a "published to the web" link (/d/e/...), whose ID is a publish token, not a file ID. ' +
        'Open the document in Drive and copy the /file/d/{id}/view or /document/d/{id}/edit URL instead.',
    );
  }

  const fromPath = path.match(DOC_PATH)?.[1] ?? path.match(GENERIC_D_PATH)?.[1];
  if (fromPath && ID_FROM_URL.test(fromPath)) {
    return { fileId: fromPath, kind: 'file', sourceUrl };
  }

  const fromQuery = paramId(parsed);
  if (fromQuery && ID_FROM_URL.test(fromQuery)) {
    return { fileId: fromQuery, kind: 'file', sourceUrl };
  }

  // A candidate that was found but failed the shape check is a different mistake from
  // finding nothing at all, and deserves to be said out loud.
  const rejected = folder ?? fromPath ?? fromQuery;
  if (rejected) {
    throw unsupported(
      sourceUrl,
      `Found ${JSON.stringify(rejected)} where a Drive file ID should be, but it is not a valid ID ` +
        '(IDs contain only letters, digits, "_" and "-").',
    );
  }

  throw unsupported(sourceUrl);
}

function paramId(parsed: URL): string | undefined {
  for (const key of ID_PARAMS) {
    const value = parsed.searchParams.get(key);
    if (value) return value;
  }
  return undefined;
}

function isFolderView(parsed: URL): boolean {
  return parsed.pathname.includes('folderview');
}

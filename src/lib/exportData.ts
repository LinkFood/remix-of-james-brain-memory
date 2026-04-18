/**
 * exportData — client-side CSV + JSON download helpers for Co-Trader.
 *
 * Purpose: James can pull his own data (trades, grades, alerts, flags,
 * principles, biases, audit trail, timeline events) off the page as a file
 * for offline analysis or backup. No server round-trips; everything is
 * what the current page already fetched.
 *
 * Safety:
 *   - `MAX_ROWS` caps any single export at 10,000 rows. Callers get a
 *     console warning and the data is truncated. A 10k row CSV is already
 *     a couple MB — past that you want the bulk-export endpoint.
 *   - Nested objects/arrays are JSON.stringify'd into a single cell. Not
 *     pretty, but round-trippable.
 *   - `downloadCsv` emits a UTF-8 BOM so Excel opens it correctly (without
 *     the BOM, Excel assumes Windows-1252 and mangles em-dashes / emoji).
 *
 * Filename convention (enforced by callers, not here): `ct-{type}-{yyyy-mm-dd}.csv`.
 */

/** Hard cap on rows per export. Anything beyond this needs the bulk endpoint. */
export const MAX_ROWS = 10_000;

/** UTF-8 BOM — makes Excel treat the file as UTF-8 instead of Win-1252. */
const UTF8_BOM = '\uFEFF';

/**
 * Escape a single CSV cell value.
 *
 * Rules (RFC 4180-ish):
 *   - null / undefined → empty string.
 *   - Objects / arrays → JSON.stringify (then escaped like any other string).
 *   - Strings with comma, quote, newline, or carriage return → wrapped in
 *     double quotes with internal quotes doubled.
 *   - Numbers / booleans → their `String(x)`.
 *
 * Date values are left as whatever the caller passed (ISO strings pass
 * through cleanly; Date objects become `Wed Jan 01 2026...` unless the
 * caller pre-formats — deliberate, callers own date formatting).
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let s: string;
  if (typeof value === 'object') {
    // Arrays + objects → JSON string. JSON.stringify handles circular refs
    // by throwing; we catch and fall back to `String(value)` so export
    // never fails mid-file.
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  } else {
    s = String(value);
  }

  const needsQuoting = /[,"\n\r]/.test(s);
  if (!needsQuoting) return s;
  // Escape internal quotes by doubling, then wrap the whole thing.
  return `"${s.replace(/"/g, '""')}"`;
}

/** Union of keys across all rows, preserving first-seen order. */
function collectHeaders(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/**
 * Serialize rows to a CSV string.
 *
 * Public mostly so tests can exercise the formatting without hitting the
 * DOM. `downloadCsv` is the normal entry point.
 */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return UTF8_BOM + '\n';

  const headers = collectHeaders(rows);
  const headerLine = headers.map(escapeCsvCell).join(',');
  const bodyLines = rows.map((row) =>
    headers.map((h) => escapeCsvCell(row[h])).join(','),
  );
  return UTF8_BOM + [headerLine, ...bodyLines].join('\r\n') + '\r\n';
}

/** Trigger a browser download via anchor + Blob. SSR-safe (no-ops). */
function triggerDownload(filename: string, blob: Blob): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick so the browser can finish the download. Revoking
  // synchronously sometimes kills the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Download `rows` as a CSV file.
 *
 * Caps at `MAX_ROWS`. Returns the number of rows actually written so the
 * caller can show a toast like "Exported 10,000 of 42,119 rows".
 */
export function downloadCsv(
  filename: string,
  rows: Record<string, unknown>[],
): number {
  const capped = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  if (rows.length > MAX_ROWS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[exportData] truncating ${rows.length} rows to ${MAX_ROWS} for ${filename}`,
    );
  }
  const csv = rowsToCsv(capped);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(filename, blob);
  return capped.length;
}

/**
 * Download arbitrary JSON-serializable data as a pretty-printed `.json`.
 *
 * Accepts anything `JSON.stringify` can handle — arrays, objects, numbers,
 * strings. For arrays of rows, behaves similarly to `downloadCsv`: caps at
 * `MAX_ROWS` and warns.
 */
export function downloadJson(filename: string, data: unknown): number {
  let payload = data;
  let written = Array.isArray(data) ? data.length : 1;
  if (Array.isArray(data) && data.length > MAX_ROWS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[exportData] truncating ${data.length} rows to ${MAX_ROWS} for ${filename}`,
    );
    payload = data.slice(0, MAX_ROWS);
    written = MAX_ROWS;
  }
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  triggerDownload(filename, blob);
  return written;
}

/**
 * Build a Co-Trader filename: `ct-{type}-{yyyy-mm-dd}.{ext}`.
 *
 * `type` is a short kebab-case identifier (e.g. `trades-closed`, `grades`,
 * `session-timeline`). Slashes, spaces, and other filename-hostile
 * characters are stripped.
 */
export function ctFilename(type: string, ext: 'csv' | 'json', date?: Date): string {
  const d = date ?? new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const safeType = type.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `ct-${safeType}-${y}-${m}-${day}.${ext}`;
}

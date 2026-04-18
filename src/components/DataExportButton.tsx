/**
 * DataExportButton — small dropdown for downloading the current page's data
 * as CSV or JSON.
 *
 * Usage:
 *   <DataExportButton
 *     data={rows}
 *     filename="trades-closed"   // becomes ct-trades-closed-yyyy-mm-dd.{ext}
 *     label="Export"             // optional; default "Export"
 *   />
 *
 * Conventions:
 *   - `data` is an array of plain objects. Nested metadata (jsonb) gets
 *     JSON.stringify'd into a single CSV cell; JSON output stays structured.
 *   - `filename` should be a kebab-case identifier — NOT a full filename.
 *     The `ct-` prefix + date + extension are appended by `ctFilename`.
 *   - When there are zero rows, the trigger stays clickable but shows a
 *     "nothing to export" toast so the user gets feedback either way.
 *
 * Icon-button styling to match the existing TopNav / panel header buttons.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Download, FileSpreadsheet, FileJson } from 'lucide-react';
import { toast } from 'sonner';
import {
  ctFilename,
  downloadCsv,
  downloadJson,
  MAX_ROWS,
} from '@/lib/exportData';

export interface DataExportButtonProps {
  /** Rows to export. Shape-flexible; keys become CSV columns. */
  data: Record<string, unknown>[];
  /** Kebab-case identifier; `ct-<filename>-<yyyy-mm-dd>.{ext}` is the final name. */
  filename: string;
  /** Button text. Defaults to "Export". */
  label?: string;
  /**
   * Optional JSON payload override. Use when the JSON export should carry
   * structure the CSV can't express (e.g. nested groupings). Falls back to
   * `data` when unset.
   */
  jsonData?: unknown;
  /** Optional: disable the trigger entirely. */
  disabled?: boolean;
}

export function DataExportButton({
  data,
  filename,
  label = 'Export',
  jsonData,
  disabled,
}: DataExportButtonProps) {
  const rowCount = Array.isArray(data) ? data.length : 0;
  const isEmpty = rowCount === 0 && (jsonData == null || (Array.isArray(jsonData) && jsonData.length === 0));

  const handleCsv = () => {
    if (rowCount === 0) {
      toast.info('Nothing to export', { description: 'No rows on this page yet.' });
      return;
    }
    const written = downloadCsv(ctFilename(filename, 'csv'), data);
    if (written < rowCount) {
      toast.warning('Export truncated', {
        description: `Wrote ${written.toLocaleString()} of ${rowCount.toLocaleString()} rows (cap ${MAX_ROWS.toLocaleString()}).`,
      });
    } else {
      toast.success('CSV exported', { description: `${written.toLocaleString()} rows` });
    }
  };

  const handleJson = () => {
    const payload = jsonData ?? data;
    if (payload == null || (Array.isArray(payload) && payload.length === 0)) {
      toast.info('Nothing to export', { description: 'No data on this page yet.' });
      return;
    }
    const written = downloadJson(ctFilename(filename, 'json'), payload);
    const payloadLen = Array.isArray(payload) ? payload.length : 1;
    if (Array.isArray(payload) && written < payloadLen) {
      toast.warning('Export truncated', {
        description: `Wrote ${written.toLocaleString()} of ${payloadLen.toLocaleString()} rows (cap ${MAX_ROWS.toLocaleString()}).`,
      });
    } else {
      toast.success('JSON exported', {
        description: Array.isArray(payload) ? `${written.toLocaleString()} rows` : 'payload saved',
      });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px] gap-1"
          disabled={disabled || isEmpty}
          title={isEmpty ? 'No data to export' : `Export ${rowCount.toLocaleString()} rows`}
        >
          <Download className="w-3 h-3" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuItem onClick={handleCsv} disabled={rowCount === 0} className="gap-2 text-xs">
          <FileSpreadsheet className="w-3.5 h-3.5" />
          Export CSV
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">
            {rowCount > 0 ? `${Math.min(rowCount, MAX_ROWS).toLocaleString()}r` : '—'}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleJson} className="gap-2 text-xs">
          <FileJson className="w-3.5 h-3.5" />
          Export JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default DataExportButton;

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  CsvExportModule,
  ModuleRegistry,
  QuickFilterModule,
  RenderApiModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
  type ColDef,
  type ICellRendererParams
} from 'ag-grid-community';
import { Download, FileText, RotateCcw } from 'lucide-react';
import { money } from '../api';
import type { Transaction } from '../types';
import { Button, StatusPill, categoryLabel } from './ui';

// Only the features this table uses (rows, sorting, quick filter, tooltips, cell classes, CSV, and
// refreshCells for the "Refunding…" state), registered here so AG Grid only loads with the caregiver
// page. ValidationModule names any missing module in the console during development and is left out
// of production builds.
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  QuickFilterModule,
  TooltipModule,
  CellStyleModule,
  CsvExportModule,
  RenderApiModule,
  ...(import.meta.env.DEV ? [ValidationModule] : [])
]);

const gridTheme = themeQuartz.withParams({
  accentColor: '#0f766e',
  backgroundColor: '#ffffff',
  foregroundColor: '#1f2a37',
  borderColor: '#e7e1d6',
  headerBackgroundColor: '#faf7f2',
  headerFontWeight: 700,
  fontFamily: 'inherit',
  fontSize: 14,
  wrapperBorderRadius: 12,
  rowHeight: 48
});

type Filter = 'ALL' | 'PAID' | 'WAITING' | 'STOPPED';
const FILTERS: Array<{ key: Filter; label: string; match: (t: Transaction) => boolean }> = [
  { key: 'ALL', label: 'All', match: () => true },
  { key: 'PAID', label: 'Paid', match: t => t.status === 'AUTO_EXECUTED' || t.status === 'APPROVED_BY_HUMAN' },
  { key: 'WAITING', label: 'Waiting', match: t => t.status === 'PENDING_APPROVAL' },
  { key: 'STOPPED', label: 'Blocked / declined / refunded', match: t => ['BLOCKED', 'REJECTED', 'REFUNDED', 'EXPIRED', 'FAILED'].includes(t.status) }
];

interface GridContext {
  refundingId: string | null;
}

export function Ledger({
  transactions,
  onViewReceipt,
  onRefund,
  refundingId
}: {
  transactions: Transaction[];
  onViewReceipt: (tx: Transaction) => void;
  onRefund: (tx: Transaction) => void;
  refundingId: string | null;
}) {
  const gridRef = useRef<AgGridReact<Transaction>>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');

  const rows = useMemo(() => transactions.filter(FILTERS.find(f => f.key === filter)!.match), [transactions, filter]);

  const columnDefs = useMemo<ColDef<Transaction>[]>(
    () => [
      {
        headerName: 'When',
        field: 'createdAt',
        sort: 'desc',
        width: 150,
        valueFormatter: p => (p.value ? new Date(p.value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
      },
      { headerName: 'Item', field: 'itemName', flex: 2, minWidth: 200, tooltipField: 'itemName' },
      {
        headerName: 'Category',
        valueGetter: p => (p.data ? categoryLabel(p.data.decisionReceipt.selectedProduct.category) : ''),
        width: 120
      },
      { headerName: 'Store', field: 'merchantName', width: 140 },
      {
        headerName: 'Amount',
        field: 'amount',
        width: 110,
        type: 'rightAligned',
        valueFormatter: p => (p.data ? money(p.value, p.data.currency) : '')
      },
      {
        headerName: 'Status',
        field: 'status',
        width: 160,
        cellRenderer: (p: ICellRendererParams<Transaction>) => (p.data ? <StatusPill status={p.data.status} /> : null)
      },
      {
        headerName: 'PayPal order',
        field: 'paypalOrderId',
        width: 170,
        cellClass: 'font-mono text-xs',
        valueFormatter: p => p.value || '—'
      },
      {
        headerName: '',
        colId: 'actions',
        width: 180,
        pinned: 'right',
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Transaction, unknown, GridContext>) => {
          const tx = p.data;
          if (!tx) return null;
          const refundingId = p.context.refundingId;
          const settled = tx.status === 'AUTO_EXECUTED' || tx.status === 'APPROVED_BY_HUMAN';
          const outside = tx.captureStatus === 'CAPTURED_OUTSIDE_APP' || (settled && !tx.paypalCaptureId);
          const pending = !outside && Boolean(tx.captureStatus) && tx.captureStatus !== 'COMPLETED';
          const refundable = settled && !pending && !outside;
          return (
            <div className="flex h-full items-center gap-2">
              <button onClick={() => onViewReceipt(tx)} className="inline-flex items-center gap-1 font-bold text-brand hover:underline">
                <FileText className="h-4 w-4" /> Receipt
              </button>
              {refundable && (
                <button
                  onClick={() => onRefund(tx)}
                  disabled={refundingId === tx.id}
                  className="inline-flex items-center gap-1 font-bold text-paypal hover:underline disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" /> {refundingId === tx.id ? 'Refunding…' : 'Refund'}
                </button>
              )}
              {settled && pending && <span className="text-xs text-muted">PayPal still processing</span>}
              {settled && outside && <span className="text-xs text-muted">Refund in PayPal</span>}
            </div>
          );
        }
      }
    ],
    // refundingId reaches the cells through the grid context, so a click doesn't rebuild every column
    [onViewReceipt, onRefund]
  );

  const context = useMemo<GridContext>(() => ({ refundingId }), [refundingId]);

  useEffect(() => {
    gridRef.current?.api?.refreshCells({ columns: ['actions'], force: true });
  }, [refundingId]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-sm font-bold ${
              filter === f.key ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-muted hover:border-brand'
            }`}
          >
            {f.label} ({transactions.filter(f.match).length})
          </button>
        ))}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search items, stores, PayPal IDs"
          className="ml-auto min-w-48 flex-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand sm:flex-none"
          aria-label="Search purchases"
        />
        <Button
          variant="secondary"
          className="text-sm"
          onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: `guardian-cart-purchases-${new Date().toISOString().slice(0, 10)}.csv` })}
        >
          <Download className="h-4 w-4" /> CSV
        </Button>
      </div>
      <div style={{ height: 360 }}>
        <AgGridReact<Transaction>
          ref={gridRef}
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          context={context}
          getRowId={p => p.data.id}
          quickFilterText={search}
          defaultColDef={{ sortable: true, resizable: true }}
          overlayNoRowsTemplate="No purchases yet. They'll appear here as soon as the helper buys or asks for something."
        />
      </div>
    </div>
  );
}

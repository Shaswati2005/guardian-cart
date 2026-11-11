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
import { Download, FileText, RotateCcw, Search } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { money } from '../api';
import type { Transaction } from '../types';
import { categoryLabel, icon, StatusPill } from './ui';

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

// Colors come from the Astryx theme tokens, so the grid follows the app's theme
const gridTheme = themeQuartz.withParams({
  accentColor: 'var(--color-accent)',
  backgroundColor: 'var(--color-background-surface)',
  foregroundColor: 'var(--color-text-primary)',
  borderColor: 'var(--color-border)',
  headerBackgroundColor: 'var(--color-background-body)',
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
  { key: 'STOPPED', label: 'Stopped', match: t => ['BLOCKED', 'REJECTED', 'REFUNDED', 'EXPIRED', 'FAILED'].includes(t.status) }
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
      { headerName: 'Item', field: 'itemName', flex: 2, minWidth: 150, tooltip: true },
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
        width: 250,
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
            <div className="flex h-full items-center gap-1">
              <Button label="Receipt" variant="ghost" size="sm" icon={icon(FileText)} className="shrink-0" onClick={() => onViewReceipt(tx)} />
              {refundable && (
                <Button
                  label={refundingId === tx.id ? 'Refunding…' : 'Refund'}
                  variant="ghost"
                  size="sm"
                  icon={icon(RotateCcw)}
                  className="shrink-0"
                  isLoading={refundingId === tx.id}
                  onClick={() => onRefund(tx)}
                />
              )}
              {settled && pending && <span className="text-xs text-secondary">PayPal still processing</span>}
              {settled && outside && <span className="text-xs text-secondary">Refund in PayPal</span>}
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
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <SegmentedControl label="Show purchases" value={filter} onChange={v => setFilter(v as Filter)}>
          {FILTERS.map(f => (
            <SegmentedControlItem key={f.key} value={f.key} label={`${f.label} (${transactions.filter(f.match).length})`} />
          ))}
        </SegmentedControl>
        <div className="ml-auto flex flex-1 items-end gap-2 sm:flex-none">
          <TextInput
            label="Search purchases"
            isLabelHidden
            type="search"
            startIcon={Search}
            placeholder="Items, stores, PayPal IDs"
            value={search}
            onChange={setSearch}
            hasClear
            width={260}
          />
          <Button
            label="CSV"
            tooltip="Download these purchases as a spreadsheet"
            icon={icon(Download)}
            onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: `guardian-cart-purchases-${new Date().toISOString().slice(0, 10)}.csv` })}
          />
        </div>
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

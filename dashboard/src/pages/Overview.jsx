import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, useApi } from '../hooks/useApi.js';
import { getTableColumns, getLabel, formatCellWithConfig, formatCurrency } from '../utils/transactionView.js';
import { formatSeq } from './Transactions.jsx';

export default function Overview() {
  const { data, loading, error } = useFetch('/api/overview');
  const navigate = useNavigate();

  if (loading) return <div className="loading">Loading overview</div>;
  if (error) return <div className="empty">Error: {error}</div>;
  if (!data) return null;

  const { name, data: db, transactions: tx, extensions, memory, sessions, messages } = data;
  const cur = tx.currency || '';
  const clickStat = { cursor: 'pointer' };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{name}</h1>
        <p className="page-desc">Agent workspace overview</p>
      </div>

      <div className="txn-summary">
        <div className="txn-summary-item">
          <div className="txn-summary-label">Revenue</div>
          <div className="txn-summary-value" style={{ color: 'var(--green)' }}>{formatCurrency(tx.revenue, cur)}</div>
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Transactions</div>
          <div className="txn-summary-value" style={{ color: 'var(--green)' }}>{tx.completed}</div>
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Messages</div>
          <div className="txn-summary-value" style={{ color: 'var(--accent)' }}>{messages || 0}</div>
        </div>
        <div className="txn-summary-item">
          <div className="txn-summary-label">Sessions</div>
          <div className="txn-summary-value" style={{ color: 'var(--accent)' }}>{sessions || 0}</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat" style={clickStat} onClick={() => navigate('data')} title="Open Data tab">
          <div className="stat-label">Data Files</div>
          <div className="stat-value">{db.files}</div>
        </div>
        <div className="stat" style={clickStat} onClick={() => navigate('data')} title="Open Data tab">
          <div className="stat-label">Records</div>
          <div className="stat-value">{db.records}</div>
        </div>
        <div className="stat" style={clickStat} onClick={() => navigate('extensions')} title="Open Extensions tab">
          <div className="stat-label">Extensions</div>
          <div className="stat-value">{extensions}</div>
        </div>
        <div className="stat" style={clickStat} onClick={() => navigate('memory')} title="Open Memory tab">
          <div className="stat-label">Memory Facts</div>
          <div className="stat-value">{memory}</div>
        </div>
      </div>

      <ConnectionStatus />
      <TransactionList currency={cur} />
    </div>
  );
}

/**
 * Connected Platforms card on Overview. Lists every configured platform
 * with a live status dot and a compact start/stop/retry control so the
 * admin doesn't have to detour through Deploy to flip a connector.
 *
 * Uses /deploy/status (the same source the Deploy page uses) so the dot
 * always reflects truth. Optimistic on click: the dot flips instantly
 * for snappy feel, and the next status fetch reconciles if the action
 * actually failed on the server.
 */
function ConnectionStatus() {
  const { data, refetch } = useFetch('/api/deploy/status');
  const api = useApi();
  const [inFlight, setInFlight] = useState({}); // { platform: true } while a click is processing

  // Poll every 15s while this page is mounted so status stays fresh as the
  // daemon's connectors come up / drop. Paused when the tab is hidden.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') refetch(); };
    const t = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refetch]);

  // Exclude integrations that aren't conversation platforms — Stripe is a
  // payment processor and OpenClaw is a backplane, neither sends inbound
  // chat events the agent reacts to. They have their own dedicated panels
  // on the Deploy / Payments pages.
  const NON_PLATFORM = new Set(['stripe', 'openclaw']);
  const platforms = (data?.platforms || []).filter(p => !NON_PLATFORM.has(p.platform));
  if (platforms.length === 0) return null;

  const toggle = async (p) => {
    if (inFlight[p.platform]) return;
    const running = p.status === 'connected';
    const action = running ? 'stop' : 'start';
    setInFlight(s => ({ ...s, [p.platform]: true }));
    try {
      await api.post(`/api/deploy/${p.platform}/${action}`);
    } catch (err) {
      // Match the Deploy page's behavior: surface the failure immediately
      // so the admin doesn't wonder why the click "did nothing."
      // The next status refetch will also reveal an `error` state with the
      // tooltip-accessible reason on the retry button.
      alert(`Failed to ${action} ${p.platform}: ${err.message || 'unknown error'}`);
    }
    setInFlight(s => { const next = { ...s }; delete next[p.platform]; return next; });
    refetch();
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title" style={{ padding: '16px 18px 8px' }}>Connected Platforms</div>
      <div style={{ padding: '0 18px 16px', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {platforms.map((p) => {
          const running = p.status === 'connected';
          const errored = p.status === 'error';
          const dotColor = running ? 'var(--green)' : errored ? 'var(--red)' : 'var(--text-muted)';
          const busy = !!inFlight[p.platform];
          const actionLabel = running ? 'Stop' : (errored ? 'Retry' : 'Start');
          const actionColor = running ? 'var(--red)' : (errored ? 'var(--yellow)' : 'var(--green)');
          return (
            <PlatformPillCard
              key={p.platform}
              name={p.platform}
              dotColor={dotColor}
              running={running}
              errored={errored}
              busy={busy}
              actionColor={actionColor}
              actionLabel={actionLabel}
              tooltip={errored && p.error ? `${actionLabel} — last error: ${p.error}` : `${actionLabel} ${p.platform}`}
              onToggle={() => toggle(p)}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Pill-shaped card holding one platform. Fully rounded so it reads as a
 * single object, with a subtle border and card background so it's clearly
 * its own little container — not just text on the page. Lifts slightly on
 * hover to reinforce the "card you can act on" affordance.
 */
function PlatformPillCard({ name, dotColor, running, errored, busy, actionColor, actionLabel, tooltip, onToggle }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 6px 6px 14px',
        background: 'var(--bg-card)',
        border: '2px solid var(--border)',
        borderRadius: 'var(--radius)', // matches the parent card's corner radius
        fontSize: 13,
        lineHeight: 1,
        boxShadow: hover ? '0 2px 8px rgba(0,0,0,0.18)' : '0 1px 2px rgba(0,0,0,0.06)',
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease',
        borderColor: hover ? 'var(--text-muted)' : 'var(--border)',
      }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%',
          background: dotColor, flexShrink: 0,
        }}
      />
      <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>{name}</span>
      <PlatformActionButton
        running={running}
        errored={errored}
        busy={busy}
        color={actionColor}
        label={actionLabel}
        tooltip={tooltip}
        onClick={onToggle}
      />
    </div>
  );
}

/**
 * Circular icon button for the Connected Platforms pills.
 *
 * Compact (24px), media-player-style. The icon alone carries the meaning
 * (triangle/square/arrow) and the full-color disc makes the affordance
 * unmistakable. No text label — keeps the pill tight.
 */
function PlatformActionButton({ running, errored, busy, color, label, tooltip, onClick }) {
  const [hover, setHover] = useState(false);
  const baseSize = 24;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={tooltip}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: baseSize, height: baseSize, borderRadius: '50%',
        background: color, border: 'none', padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: '#ffffff', cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.55 : 1,
        transform: hover && !busy ? 'scale(1.08)' : 'scale(1)',
        transition: 'transform 0.12s ease, filter 0.12s ease',
        filter: hover && !busy ? 'brightness(1.1)' : 'none',
        boxShadow: hover && !busy ? `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)` : 'none',
        flexShrink: 0,
      }}
    >
      {busy
        ? <Spinner color="#ffffff" />
        : running
          ? (
            // square — stop. Centered with a small inset for visual balance.
            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          )
          : errored
            ? (
              // circular arrow — retry
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            )
            : (
              // play — slightly offset right so the triangle's optical center
              // sits in the disc's geometric center.
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginLeft: 2 }}>
                <path d="M7 4.5v15l13-7.5z" />
              </svg>
            )}
    </button>
  );
}

function Spinner({ color }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="3" strokeLinecap="round" style={{ animation: 'spin 0.9s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

const OVERVIEW_TXN_PREVIEW = 5;

function TransactionList({ currency }) {
  const navigate = useNavigate();
  const { data, loading } = useFetch('/api/transactions');
  const { data: viewConfig } = useFetch('/api/transaction-view');

  if (loading) return <div className="loading">Loading transactions</div>;
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="empty" style={{ padding: 30 }}>No active transactions yet</div>
      </div>
    );
  }

  const extraCols = getTableColumns(viewConfig, data);
  const hasMore = data.length > OVERVIEW_TXN_PREVIEW;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-title" style={{ padding: '16px 18px 0' }}>Active Transactions</div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 56 }}>#</th>
            <th>Service</th>
            <th>User</th>
            <th>Status</th>
            {extraCols.map(k => <th key={k}>{getLabel(viewConfig, k)}</th>)}
            <th>Cost</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {data.slice(0, OVERVIEW_TXN_PREVIEW).map((t, i) => {
            const seq = formatSeq(t);
            return (
            <tr key={t.id || i} onClick={() => navigate(`transactions?id=${encodeURIComponent(t.id || t._file)}`)} style={{ cursor: 'pointer' }}>
              <td
                title={t.id || ''}
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 13,
                  color: 'var(--text-muted)',
                  width: 56,
                  whiteSpace: 'nowrap',
                }}
              >{seq}</td>
              <td>{t.service || ''}</td>
              <td>{t.user_name || t.user || t.client || ''}</td>
              <td><span className={`badge ${t.status}`}>{t.status?.replace(/_/g, ' ')}</span></td>
              {extraCols.map(k => (
                <td key={k} style={{ fontSize: 13 }}>{formatCellWithConfig(t[k], k, viewConfig, currency)}</td>
              ))}
              <td>{t.cost ? formatCurrency(t.cost, currency) : 'Free'}</td>
              <td>{t.created_at ? new Date(t.created_at).toLocaleDateString() : ''}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore && (
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => navigate('transactions')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: 'var(--accent)', fontSize: 13, fontWeight: 500,
            }}
          >
            View all ({data.length})
          </button>
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useRef } from 'react';
import { useApi } from '../hooks/useApi.js';

/**
 * Top-level "agent is down" popup for non-technical clients.
 *
 * Only shown in BASIC nav mode (clients can't see the Deploy tab and can't
 * fix it themselves) and only when a connector has failed beyond recovery
 * (health.state === 'error'). Admins get the calm sidebar LED instead.
 *
 * The goal is escalation, not repair: tell them plainly, give copyable
 * details, and point them at whoever supports them. Dismiss hides it for the
 * session (the red LED stays); a brand-new outage re-shows it.
 */
export default function AgentDownAlert({ health, basic }) {
  const api = useApi();
  const [dismissed, setDismissed] = useState(false);
  const [support, setSupport] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef(null);
  useEffect(() => () => clearTimeout(copyTimeoutRef.current), []);

  const isError = health?.state === 'error';

  // Reset dismissal when the error clears, so a later outage shows again.
  useEffect(() => { if (!isError) setDismissed(false); }, [isError]);

  // Pull an optional support contact configured by the operator.
  useEffect(() => {
    if (!isError) return;
    let cancelled = false;
    api.get('/api/config')
      .then(c => { if (!cancelled) setSupport(c?.support_contact || ''); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError]);

  if (!isError || !basic || dismissed) return null;

  const platforms = (health.errored || []).map(e => e.platform).join(', ');
  const details = [
    'Agent issue report',
    `Time: ${new Date().toLocaleString()}`,
    `Affected: ${platforms || 'unknown'}`,
    ...(health.errored || []).map(e => `- ${e.platform}: ${e.error || 'stopped unexpectedly'}`),
  ].join('\n');

  const copy = () => {
    try { navigator.clipboard?.writeText(details); } catch { /* ignore */ }
    setCopied(true);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div className="card" style={{ maxWidth: 460, width: '100%', borderTop: '4px solid var(--red)' }}>
        <div className="card-body">
          <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 8 }}>⚠️</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Your agent needs attention</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)', margin: '0 0 12px' }}>
            Part of your agent ({platforms || 'a connection'}) ran into a problem and
            couldn’t recover on its own. Customers may not be getting replies right now.
          </p>
          <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 12px' }}>
            {support
              ? <>Please contact <strong>{support}</strong> and share the details below.</>
              : <>Please contact whoever set up your agent and share the details below.</>}
          </p>
          <pre style={{
            fontSize: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap', margin: '0 0 14px',
          }}>{details}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy details'}</button>
            <button className="btn" onClick={() => setDismissed(true)}>Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  );
}

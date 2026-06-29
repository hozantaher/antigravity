import React, { useState } from 'react';

const scrapers = [
  { id: 'mobile-de', name: 'Mobile.de (Osobní a užitková vozidla)', icon: '🚗' },
  { id: 'mascus-cz', name: 'Mascus.cz (Zemědělská a těžká technika)', icon: '🚜' },
  { id: 'autoline', name: 'Autoline (Kamiony)', icon: '🚚' },
  { id: 'firmy-cz', name: 'Firmy.cz (B2B Flotily)', icon: '🏢' },
  { id: 'judikaty', name: 'Judikáty (Soudní rozhodnutí)', icon: '⚖️' },
  { id: 'esbirka', name: 'eSbírka (Legislativa)', icon: '📜' },
];

export function ScraperControlPanel() {
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const handleCommand = async (target, phase) => {
    setLoading(true);
    setStatusMsg(`Sending ${phase} command to ${target}...`);
    try {
      const res = await fetch('/api/scrapers/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, phase }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setStatusMsg(`✅ Command queued! Job ID: ${data.jobId}`);
      setTimeout(() => setStatusMsg(''), 5000);
    } catch (err) {
      console.error(err);
      setStatusMsg(`❌ Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const panelStyle = {
    background: '#fff',
    padding: '24px',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    border: '1px solid #eaeaea',
    marginTop: '32px'
  };

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: '16px',
    marginTop: '16px'
  };

  const cardStyle = {
    border: '1px solid #e2e8f0',
    padding: '16px',
    borderRadius: '6px',
    background: '#f8fafc',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between'
  };

  const btnStyle = {
    padding: '8px 12px',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: '500',
    fontSize: '13px',
    flex: 1
  };

  const startBtnStyle = { ...btnStyle, background: '#4f46e5', color: '#fff', marginRight: '8px' };
  const phaseBtnStyle = { ...btnStyle, background: '#e2e8f0', color: '#1e293b', marginRight: '8px' };

  return (
    <div style={panelStyle}>
      <h2 style={{ margin: '0 0 16px 0', fontSize: '18px', borderBottom: '1px solid #eaeaea', paddingBottom: '8px' }}>
        Antigravity Remote Control (Scraper Daemons)
      </h2>
      
      {statusMsg && (
        <div style={{ background: '#eff6ff', color: '#1e40af', padding: '12px', borderRadius: '4px', marginBottom: '16px', fontSize: '14px', fontWeight: '500' }}>
          {statusMsg}
        </div>
      )}

      <div style={gridStyle}>
        {scrapers.map((s) => (
          <div key={s.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '24px', marginRight: '8px' }}>{s.icon}</span>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#334155' }}>{s.name}</h3>
            </div>
            <div style={{ display: 'flex' }}>
              <button disabled={loading} style={startBtnStyle} onClick={() => handleCommand(s.id, 'all')}>
                Start All
              </button>
              <button disabled={loading} style={phaseBtnStyle} onClick={() => handleCommand(s.id, 'sitemap')}>
                Sitemap
              </button>
              <button disabled={loading} style={{...phaseBtnStyle, marginRight: 0}} onClick={() => handleCommand(s.id, 'detail')}>
                Detail
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

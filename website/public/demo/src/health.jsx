// Health / audit dashboard
const { Favicon: Fh, fmtRel: fh } = window.ZPASS_UI;
const Ih = window.ZPASS_ICONS;
const { useI18n: hUseI18n } = window.ZPASS_I18N;

function Health({ items, breaches, activity, onOpenItem }) {
  const { t } = hUseI18n();
  const weak = items.filter(i => i.type === 'login' && (i.strength || 100) < 60);
  const reused = items.filter(i => i.reused);
  const breached = items.filter(i => i.breached);
  const old = items.filter(i => i.type === 'login' && (Date.now() - i.modified) > 365*24*3600*1000);
  const noTotp = items.filter(i => i.type === 'login' && !i.totp);

  // Overall score
  const loginItems = items.filter(i => i.type === 'login');
  const avgStrength = Math.round(loginItems.reduce((a,b) => a + (b.strength || 80), 0) / loginItems.length);
  const score = Math.max(0, Math.min(100, avgStrength - weak.length*2 - reused.length*3 - breached.length*6));

  return (
    <div className="health">
      <h1>{t('health_title')}</h1>
      <p className="lede">{t('health_lede_prefix')}<span className="mono">2m</span>{t('health_lede_mid')}<span className="mono">58m</span></p>

      <div className="grid-4">
        <div className="stat hero">
          <div className="k">{t('health_score_k')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 6 }}>
            <div className="big-score">
              <div className="v">{score}</div>
              <small>/ 100</small>
            </div>
            <div className="donut" style={{ '--p': score }} data-label={score >= 80 ? 'A' : score >= 60 ? 'B' : 'C'} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
              <div>{t('health_score_week')}</div>
              <div style={{color:'var(--text-2)'}}>{t('health_score_fix', weak.length + reused.length + breached.length)}</div>
            </div>
          </div>
          <div className="d" style={{ marginTop: 'auto' }}>{t('health_score_desc')}</div>
        </div>
        <div className="stat">
          <div className="k">{t('health_breached_k')}</div>
          <div className="v" style={{ color: breached.length ? 'var(--danger)' : 'var(--text)' }}>{breached.length}</div>
          <div className="d">{t('health_breached_d')}</div>
        </div>
        <div className="stat">
          <div className="k">{t('health_2fa_k')}</div>
          <div className="v">{Math.round(100 - (noTotp.length/loginItems.length)*100)}%</div>
          <div className="d">{t('health_2fa_d', loginItems.length - noTotp.length, loginItems.length)}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        <Tile icon="Alert" label={t('health_tile_weak')} count={weak.length} sev="high" />
        <Tile icon="Refresh" label={t('health_tile_reused')} count={reused.length} sev="high" />
        <Tile icon="Clock" label={t('health_tile_old')} count={old.length} sev="med" />
        <Tile icon="Shield" label={t('health_tile_no2fa')} count={noTotp.length} sev="med" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h3>{t('health_actions')}</h3>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('health_actions_found', weak.length + reused.length + breached.length)}</span>
            <div className="spacer"/>
            <button className="btn sm">{t('health_rotate_all')}</button>
          </div>
          <div className="panel-body">
            {[...breached, ...weak.filter(w => !w.breached), ...reused.filter(r => !r.breached && !weak.includes(r))].slice(0,8).map(it => (
              <div key={it.id} className="panel-row" onClick={() => onOpenItem(it.id)} style={{cursor:'pointer'}}>
                <Fh item={it} size={28} />
                <div>
                  <div>{it.name}</div>
                  <div className="sub">{it.username}</div>
                </div>
                <span className={"sev " + (it.breached ? 'crit' : 'high')}>
                  {it.breached ? t('sev_breach') : it.weak ? t('sev_weak') : t('sev_reused')}
                </span>
                <button className="btn sm">{t('health_fix')}</button>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>{t('health_breach_monitor')}</h3>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('health_breach_src')}</span>
          </div>
          <div className="panel-body breach-feed">
            {breaches.map(b => {
              const matchedItem = b.matchedItem ? items.find(i => i.id === b.matchedItem) : null;
              return (
                <div key={b.id} className={"breach-row sev-" + b.severity + " status-" + b.status}
                     onClick={() => matchedItem && onOpenItem(matchedItem.id)}
                     style={{ cursor: matchedItem ? 'pointer' : 'default' }}>
                  <div className="sev-stripe"/>
                  <div style={{ minWidth: 0 }}>
                    <div className="br-head">
                      <span className="br-name">{b.name}</span>
                      <span className="br-date">{b.date}</span>
                      {matchedItem && <span className="breach-match"><Fh item={matchedItem} size={14} /> {t('breach_matches')} {matchedItem.name}</span>}
                    </div>
                    <div className="br-sum">{b.summary}</div>
                    <div className="br-chips">
                      {b.data.map(d => <span key={d} className="br-chip">{d}</span>)}
                    </div>
                    <div className="br-meta">
                      <span><span className="k">{t('breach_lbl_vector')}</span><span className="v">{b.vector}</span></span>
                      <span><span className="k">{t('breach_lbl_source')}</span><span className="v">{b.source}</span></span>
                      <span><span className="k">{t('breach_lbl_scale')}</span><span className="v">{(b.affected/1e6).toFixed(b.affected < 1e6 ? 3 : 1)}M</span></span>
                    </div>
                  </div>
                  <div className="br-side">
                    <span className={"br-status " + b.status}>{t('breach_status_' + b.status)}</span>
                    {matchedItem && b.status !== 'resolved' && (
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); onOpenItem(matchedItem.id); }}>{t('breach_rotate')}</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head"><h3>{t('health_activity')}</h3><div className="spacer"/><span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('health_local')}</span></div>
          <div className="panel-body">
            {activity.map((a, i) => (
              <div key={i} className="panel-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.t}</span>
                <div>{a.msg}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h3>{t('health_dist')}</h3></div>
          <div style={{ padding: 24 }}>
            <StrengthHisto items={loginItems} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Tile({ icon, label, count, sev }) {
  const Icon = Ih[icon];
  return (
    <div className="stat" style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 36, height: 36, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elev-2)', color: sev === 'high' ? 'var(--danger)' : 'var(--text-2)', border: '1px solid var(--line)' }}>
        <Icon size={16}/>
      </div>
      <div>
        <div className="v" style={{ fontSize: 22 }}>{count}</div>
        <div className="d">{label}</div>
      </div>
    </div>
  );
}

function StrengthHisto({ items }) {
  const bins = [0,0,0,0,0]; // 0-20, 20-40, 40-60, 60-80, 80-100
  for (const it of items) {
    const s = it.strength || 80;
    bins[Math.min(4, Math.floor(s/20))]++;
  }
  const max = Math.max(...bins, 1);
  const labels = ['0–20', '20–40', '40–60', '60–80', '80–100'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--text-3)', 'var(--text-2)', 'var(--text)'];
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 140 }}>
      {bins.map((b, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>{b}</div>
          <div style={{ width: '100%', height: (b/max)*100 + '%', minHeight: 2, background: colors[i], borderRadius: 4, transition: 'height 0.4s' }}/>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

window.ZPASS_Health = Health;

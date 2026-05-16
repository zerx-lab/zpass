// zp-security.jsx — Security overview + breach feed

function ZPSecurity({ theme = 'dark', t }) {
  const c = ZP_TOKENS[theme];
  const score = 82;
  const size = 130, stroke = 6;
  const r = size/2 - stroke, circ = 2 * Math.PI * r;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '8px 20px 6px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.02 }}>{t('health_title')}</h1>
        <div style={{ marginTop: 2, fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>Last scan · 2m ago</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 20px' }}>
        {/* score hero */}
        <div style={{
          padding: '20px', border: `1px solid ${c.line}`, borderRadius: 14, background: c.bgElev,
          display: 'flex', alignItems: 'center', gap: 18,
        }}>
          <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
            <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
              <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c.lineSoft} strokeWidth={stroke}/>
              <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c.text} strokeWidth={stroke}
                strokeDasharray={circ} strokeDashoffset={circ * (1 - score/100)} strokeLinecap="round"/>
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 36, fontWeight: 600, letterSpacing: -0.02 }}>{score}</div>
              <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, color: c.text3, textTransform: 'uppercase', letterSpacing: 0.08 }}>/ 100</div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, textTransform: 'uppercase', letterSpacing: 0.08 }}>{t('health_score_k')}</div>
            <div style={{ marginTop: 4, fontSize: 13, color: c.text2 }}>{t('health_score_week')}</div>
            <div style={{ marginTop: 8, fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>{t('health_score_fix', 5)}</div>
          </div>
        </div>

        {/* tiles */}
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            { k: t('health_tile_weak'), v: 3 },
            { k: t('health_tile_reused'), v: 2 },
            { k: t('health_tile_old'), v: 4 },
            { k: t('health_tile_no2fa'), v: 6 },
          ].map((tt, i) => (
            <div key={i} style={{
              padding: '14px', border: `1px solid ${c.line}`, borderRadius: 10, background: c.bgElev,
            }}>
              <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, color: c.text3, textTransform: 'uppercase', letterSpacing: 0.08 }}>{tt.k}</div>
              <div style={{ marginTop: 6, fontFamily: ZP_FONTS.mono, fontSize: 24, fontWeight: 600, letterSpacing: -0.02 }}>{tt.v}</div>
            </div>
          ))}
        </div>

        {/* Breach monitor */}
        <ZPSectionHeader theme={theme} style={{ padding: '18px 0 10px' }}>{t('health_breach_monitor')}</ZPSectionHeader>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { name: 'linear.app', date: '2026-04-14', sev: 'crit', status: 'new', affected: '184k', vec: 'OAuth token leak', matched: true },
            { name: 'twitter.com', date: '2026-04-02', sev: 'crit', status: 'open', affected: '209M', vec: 'API scraping', matched: true },
            { name: 'notion.so', date: '2026-03-28', sev: 'high', status: 'open', affected: '590k', vec: '3rd-party', matched: true },
            { name: 'duolingo.com', date: '2026-02-17', sev: 'med', status: 'clear', affected: '2.6M', vec: 'Enumeration', matched: false },
          ].map((b, i) => {
            const sevColor = b.sev === 'crit' ? c.danger : b.sev === 'high' ? c.warn : c.text3;
            return (
              <div key={i} style={{
                padding: '12px 14px', borderRadius: 10,
                border: `1px solid ${b.sev === 'crit' ? `color-mix(in oklab, ${c.danger} 40%, ${c.line})` : c.lineSoft}`,
                background: b.sev === 'crit' ? `color-mix(in oklab, ${c.danger} 5%, ${c.bgElev})` : c.bgElev,
                display: 'grid', gridTemplateColumns: '3px 1fr auto', gap: 12,
              }}>
                <div style={{ background: sevColor, borderRadius: 2 }}/>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 13, fontWeight: 500 }}>{b.name}</span>
                    <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>{b.date}</span>
                  </div>
                  <div style={{ marginTop: 6, fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, textTransform: 'uppercase', letterSpacing: 0.06, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span><span style={{ color: c.text4 }}>{t('breach_lbl_scale')}</span> <span style={{ color: c.text2 }}>{b.affected}</span></span>
                    <span><span style={{ color: c.text4 }}>{t('breach_lbl_vector')}</span> <span style={{ color: c.text2 }}>{b.vec}</span></span>
                  </div>
                  {b.matched && (
                    <div style={{
                      marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '2px 7px', borderRadius: 4,
                      background: `color-mix(in oklab, ${c.danger} 10%, transparent)`,
                      border: `1px solid color-mix(in oklab, ${c.danger} 30%, ${c.line})`,
                      color: c.danger, fontFamily: ZP_FONTS.mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.06,
                    }}>
                      <IconAlert size={11}/> {t('breach_matched_item')}
                    </div>
                  )}
                </div>
                <div style={{
                  fontFamily: ZP_FONTS.mono, fontSize: 8, fontWeight: 600, letterSpacing: 0.1,
                  padding: '3px 7px', borderRadius: 4, height: 'fit-content',
                  background: b.status === 'new' ? c.danger : 'transparent',
                  color: b.status === 'new' ? '#fff' : (b.status === 'open' ? c.warn : c.text3),
                  border: b.status === 'new' ? 0 : `1px solid ${b.status === 'open' ? `color-mix(in oklab, ${c.warn} 40%, ${c.line})` : c.line}`,
                }}>{t(`breach_status_${b.status}`)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ZPSecurity });

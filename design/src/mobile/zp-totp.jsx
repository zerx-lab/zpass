// zp-totp.jsx — Full-bleed TOTP viewer with giant countdown

function ZPTotp({ theme = 'dark', t, items }) {
  const c = ZP_TOKENS[theme];
  const active = items[0];
  const secs = 18;
  const pct = secs / 30;
  const size = 260;
  const stroke = 4;
  const r = size / 2 - stroke;
  const circ = 2 * Math.PI * r;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: c.bg, minHeight: 0 }}>
      {/* tiny header */}
      <div style={{ padding: '10px 20px 6px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.02, flex: 1 }}>{t('sec_totp')}</h1>
        <button style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${c.line}`, background: c.bgElev, color: c.text2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconPlus size={18}/></button>
      </div>

      {/* active */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 24px' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '6px 12px', border: `1px solid ${c.line}`, borderRadius: 999, background: c.bgElev }}>
          <ZPFav t={active.favT} theme={theme} size={22}/>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{active.name}</span>
          <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>· {active.username}</span>
        </div>

        <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={size} height={size} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c.lineSoft} strokeWidth={stroke}/>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={c.text} strokeWidth={stroke}
              strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)} strokeLinecap="round"/>
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 44, fontWeight: 600, letterSpacing: 0.14, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>068 508</div>
            <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text3 }}>{t('mob_next_code')} <b style={{ color: c.text }}>{secs}s</b></div>
            <div style={{ marginTop: 6, fontFamily: ZP_FONTS.mono, fontSize: 9, color: c.text4, textTransform: 'uppercase', letterSpacing: 0.08 }}>SHA1 · 30s · 6 digits</div>
          </div>
        </div>

        <button style={{
          marginTop: 6, padding: '10px 18px', borderRadius: 999,
          background: c.text, color: c.bg, border: 0,
          fontSize: 13, fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', gap: 8,
        }}><IconCopy size={14}/> {t('mob_copy_totp')}</button>

        <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, textAlign: 'center' }}>{t('mob_totp_hint')}</div>
      </div>

      {/* up-next strip */}
      <div style={{ borderTop: `1px solid ${c.lineSoft}`, padding: '10px 16px', display: 'flex', gap: 8, overflowX: 'auto' }}>
        {items.slice(1, 6).map(it => (
          <div key={it.id} style={{
            flexShrink: 0, padding: '8px 10px', borderRadius: 8,
            border: `1px solid ${c.line}`, background: c.bgElev,
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 160,
          }}>
            <ZPFav t={it.favT} theme={theme} size={26}/>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12 }}>{it.name}</div>
              <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 13, letterSpacing: 0.08, color: c.text2 }}>421 908</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { ZPTotp });

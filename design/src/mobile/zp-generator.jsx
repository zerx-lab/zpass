// zp-generator.jsx — Password generator (mobile)

function ZPGenerator({ theme = 'dark', t }) {
  const c = ZP_TOKENS[theme];
  const [mode, setMode] = React.useState('password');
  const [len, setLen] = React.useState(20);

  const pwd = 'q7!Nv4zB$eRp2xUmK9wY';
  const colored = pwd.split('').map((ch, i) => {
    let color = c.text;
    if (/[0-9]/.test(ch)) color = c.text;
    else if (/[A-Z]/.test(ch)) color = c.text;
    else if (/[^a-zA-Z0-9]/.test(ch)) color = c.text3;
    else color = c.text2;
    return <span key={i} style={{ color }}>{ch}</span>;
  });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '8px 20px 6px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.02 }}>{t('gen_title')}</h1>
        <div style={{ marginTop: 2, fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>{t('gen_badge')}</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 20px' }}>
        {/* display */}
        <div style={{
          padding: '22px 18px', borderRadius: 12, border: `1px solid ${c.line}`,
          background: c.bgElev, position: 'relative',
          fontFamily: ZP_FONTS.mono, fontSize: 22, fontWeight: 500,
          letterSpacing: 0.02, wordBreak: 'break-all', lineHeight: 1.3,
        }}>
          {colored}
          <span style={{
            position: 'absolute', top: 10, right: 12,
            fontSize: 9, textTransform: 'uppercase', color: c.text3, letterSpacing: 0.1,
          }}>{len} {t('gen_chars')}</span>
        </div>

        {/* quick actions */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
          <button style={{
            height: 44, borderRadius: 10, border: `1px solid ${c.line}`, background: c.bgElev,
            color: c.text, fontSize: 13, fontWeight: 500,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}><IconRefresh size={16}/> {t('gen_regen')}</button>
          <button style={{
            height: 44, borderRadius: 10, border: 0, background: c.text,
            color: c.bg, fontSize: 13, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}><IconCopy size={16}/> {t('gen_copy')}</button>
        </div>

        {/* mode segmented */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 8 }}>{t('mob_gen_mode')}</div>
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${c.line}`, background: c.bg }}>
            {['password','passphrase','pin'].map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                flex: 1, height: 36, fontSize: 12,
                background: mode === m ? c.text : 'transparent',
                color: mode === m ? c.bg : c.text2,
                border: 0, fontWeight: mode === m ? 600 : 400,
              }}>{t(`gen_mode_${m}`)}</button>
            ))}
          </div>
        </div>

        {/* length slider */}
        <div style={{ marginTop: 22, padding: '14px 16px', border: `1px solid ${c.line}`, borderRadius: 10, background: c.bgElev }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, color: c.text2 }}>{t('gen_length')}</span>
            <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 20, fontWeight: 600 }}>{len}</span>
          </div>
          <input type="range" min="6" max="64" value={len} onChange={e => setLen(+e.target.value)}
            style={{ width: '100%', marginTop: 10, accentColor: c.text }}/>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, marginTop: 2 }}>
            <span>6</span><span>32</span><span>64</span>
          </div>
        </div>

        {/* toggles */}
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            { label: t('gen_upper'), on: true, sub: 'A-Z' },
            { label: t('gen_lower'), on: true, sub: 'a-z' },
            { label: t('gen_numbers'), on: true, sub: '0-9' },
            { label: t('gen_symbols'), on: true, sub: '!@#$' },
            { label: t('gen_avoid_amb'), on: false, sub: 'Il1O0' },
            { label: t('gen_pronounce'), on: false, sub: '' },
          ].map((tg, i) => (
            <div key={i} style={{
              padding: '12px 12px', borderRadius: 10, border: `1px solid ${c.line}`, background: c.bgElev,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tg.label}</div>
                {tg.sub && <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, color: c.text3 }}>{tg.sub}</div>}
              </div>
              <div style={{
                width: 32, height: 18, borderRadius: 999, flexShrink: 0,
                background: tg.on ? c.text : c.line, position: 'relative',
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: tg.on ? 16 : 2,
                  width: 14, height: 14, borderRadius: '50%',
                  background: tg.on ? c.bg : c.text,
                  transition: 'left .15s',
                }}/>
              </div>
            </div>
          ))}
        </div>

        {/* save */}
        <button style={{
          marginTop: 16, width: '100%', height: 44, borderRadius: 10,
          border: `1px solid ${c.line}`, background: c.bg, color: c.text,
          fontSize: 13, fontWeight: 500, fontFamily: ZP_FONTS.sans,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}><IconPlus size={16}/> {t('gen_save')}</button>
      </div>
    </div>
  );
}

Object.assign(window, { ZPGenerator });

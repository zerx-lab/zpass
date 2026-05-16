// zp-unlock.jsx — Unlock screen variations

function ZPUnlockFaceID({ theme = 'dark', t, platform = 'ios' }) {
  const c = ZP_TOKENS[theme];
  const [phase, setPhase] = React.useState(0); // 0 scanning, 1 success
  React.useEffect(() => {
    const id = setTimeout(() => setPhase(1), 2200);
    return () => clearTimeout(id);
  }, []);
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      background: c.bg, position: 'relative', overflow: 'hidden',
    }}>
      {/* grid bg */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `linear-gradient(to right, ${c.grid} 1px, transparent 1px), linear-gradient(to bottom, ${c.grid} 1px, transparent 1px)`,
        backgroundSize: '28px 28px',
        maskImage: 'radial-gradient(400px 400px at 50% 45%, black, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(400px 400px at 50% 45%, black, transparent 75%)',
      }}/>

      {/* brand top */}
      <div style={{ padding: '40px 28px 0', display: 'flex', alignItems: 'center', gap: 10, position: 'relative', zIndex: 1 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, background: c.text, color: c.bg,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: ZP_FONTS.mono, fontWeight: 700, fontSize: 14,
        }}>Z</div>
        <div style={{ fontWeight: 600, letterSpacing: -0.01, fontSize: 16 }}>ZPass</div>
        <div style={{
          marginLeft: 'auto', fontFamily: ZP_FONTS.mono, fontSize: 10,
          color: c.text3, padding: '3px 7px', border: `1px solid ${c.line}`, borderRadius: 4,
        }}>{t('unlock_brand_sub')}</div>
      </div>

      {/* center stack */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 28px', position: 'relative', zIndex: 1 }}>
        {/* face id ring */}
        <div style={{
          position: 'relative', width: 104, height: 104, marginBottom: 32,
        }}>
          {/* rotating outer scan */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            border: `1.5px solid ${c.line}`,
          }}/>
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            borderTop: `1.5px solid ${c.text}`,
            borderLeft: `1.5px solid ${c.text}`,
            borderRight: '1.5px solid transparent',
            borderBottom: '1.5px solid transparent',
            animation: phase === 0 ? 'zpSpin 1.2s linear infinite' : 'none',
            opacity: phase === 0 ? 1 : 0.3,
          }}/>
          <div style={{
            position: 'absolute', inset: 18, borderRadius: '50%',
            background: c.bgElev, border: `1px solid ${c.line}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: c.text,
          }}>
            {phase === 1 ? <IconCheck size={30}/> : <IconFace size={36}/>}
          </div>
          <style>{`
            @keyframes zpSpin { to { transform: rotate(360deg); } }
            @keyframes zpPulse { 0%,100% { opacity: .3 } 50% { opacity: 1 } }
          `}</style>
        </div>

        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: -0.02, textAlign: 'center' }}>
          {t('mob_unlock_hi')}
        </h1>
        <div style={{
          marginTop: 6, fontFamily: ZP_FONTS.mono, fontSize: 12, color: c.text3,
        }}>{t('mob_unlock_sub')}</div>

        <div style={{
          marginTop: 40, padding: '10px 16px', borderRadius: 999,
          border: `1px dashed ${c.line}`, color: c.text2,
          fontSize: 12, display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.text2, animation: 'zpPulse 1.5s ease-in-out infinite' }}/>
          {platform === 'ios' ? t('mob_unlock_faceid') : t('mob_unlock_faceid_android')}
        </div>
      </div>

      {/* footer */}
      <div style={{ padding: '0 28px 32px', display: 'flex', flexDirection: 'column', gap: 10, position: 'relative', zIndex: 1 }}>
        <button style={{
          height: 48, borderRadius: 8, border: `1px solid ${c.line}`,
          background: c.bgElev, color: c.text, fontSize: 14, fontWeight: 500,
        }}>{t('mob_unlock_usepw')}</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>
          <span>argon2id · zero-knowledge</span>
          <span>{t('mob_unlock_switch')}</span>
        </div>
      </div>
    </div>
  );
}

function ZPUnlockPIN({ theme = 'dark', t, platform = 'ios' }) {
  const c = ZP_TOKENS[theme];
  const [code, setCode] = React.useState('••');
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: c.bg, padding: '20px 24px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6, background: c.text, color: c.bg,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: ZP_FONTS.mono, fontWeight: 700, fontSize: 13,
        }}>Z</div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>ZPass</div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 28 }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t('mob_unlock_enter_pin')}</h2>
          <div style={{ marginTop: 6, fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text3 }}>6-digit numeric</div>
        </div>

        {/* PIN dots */}
        <div style={{ display: 'flex', gap: 14 }}>
          {[0,1,2,3,4,5].map(i => (
            <div key={i} style={{
              width: 14, height: 14, borderRadius: '50%',
              background: i < 2 ? c.text : 'transparent',
              border: `1.5px solid ${i < 2 ? c.text : c.line}`,
              transition: 'all .15s',
            }}/>
          ))}
        </div>

        {/* numeric pad */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 76px)', gap: 14 }}>
          {keys.map((k, i) => (
            <button key={i} disabled={!k} style={{
              height: 76, borderRadius: '50%',
              background: k ? c.bgElev : 'transparent',
              border: k ? `1px solid ${c.line}` : 'none',
              color: c.text, fontSize: 24, fontWeight: 400,
              fontFamily: ZP_FONTS.mono,
              cursor: k ? 'pointer' : 'default',
            }}>{k}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: c.text3 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconFace size={16}/> Face ID
        </span>
        <span>{t('unlock_forgot')}</span>
      </div>
    </div>
  );
}

Object.assign(window, { ZPUnlockFaceID, ZPUnlockPIN });

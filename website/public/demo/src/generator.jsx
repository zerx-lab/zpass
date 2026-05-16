// Password generator
const { useState: gS, useEffect: gE, useMemo: gM } = React;
const { useToast: gUT, copyText: gCp, colorize: gCz, randomPw: gRp, pwStrength: gPs, wordwords: gWw } = window.ZPASS_UI;
const Ig = window.ZPASS_ICONS;
const { useI18n: gUseI18n } = window.ZPASS_I18N;

function Generator() {
  const [mode, setMode] = gS('password');
  const [len, setLen] = gS(20);
  const [words, setWords] = gS(5);
  const [lower, setLower] = gS(true);
  const [upper, setUpper] = gS(true);
  const [numbers, setNums] = gS(true);
  const [symbols, setSyms] = gS(true);
  const [pw, setPw] = gS('');
  const [history, setHistory] = gS([]);
  const toast = gUT();
  const { t } = gUseI18n();

  const regen = () => {
    const out = mode === 'password'
      ? gRp({ length: len, lower, upper, numbers, symbols })
      : gWw(words);
    setPw(out);
    setHistory(h => [{ pw: out, t: Date.now() }, ...h].slice(0, 6));
  };

  gE(() => { regen(); }, [mode, len, words, lower, upper, numbers, symbols]);

  const strength = gM(() => gPs(pw), [pw]);
  const label = strength < 40 ? t('strength_weak') : strength < 70 ? t('strength_fair') : strength < 85 ? t('strength_strong') : t('strength_excellent');

  return (
    <div className="gen-wrap">
      <div className="gen-left">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>{t('gen_title')}</h1>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)', padding: '2px 8px', border: '1px solid var(--line)', borderRadius: 4 }}>
              {t('gen_badge')}
            </span>
          </div>
          <p style={{ margin: 0, color: 'var(--text-3)', fontSize: 13 }}>{t('gen_sub')}</p>
        </div>

        <div className="gen-display">
          <div className="overlay">{mode === 'password' ? `${len} ${t('gen_chars')}` : `${words} ${t('gen_words').toLowerCase()}`} · {label}</div>
          {gCz(pw)}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={regen}><Ig.Refresh size={14}/> {t('gen_regen')}</button>
          <button className="btn primary" onClick={() => gCp(pw, toast, t('lbl_password'))}><Ig.Copy size={14}/> {t('gen_copy')}</button>
          <div style={{ flex: 1 }} />
          <button className="btn"><Ig.Plus size={14}/> {t('gen_save')}</button>
        </div>

        <div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, border: '1px solid var(--line)', borderRadius: 6, padding: 3, width: 'fit-content', background: 'var(--bg-elev)' }}>
            <button
              onClick={() => setMode('password')}
              style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, background: mode==='password' ? 'var(--text)' : 'transparent', color: mode==='password' ? 'var(--bg)' : 'var(--text-2)' }}>
              {t('gen_mode_password')}
            </button>
            <button
              onClick={() => setMode('passphrase')}
              style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, background: mode==='passphrase' ? 'var(--text)' : 'transparent', color: mode==='passphrase' ? 'var(--bg)' : 'var(--text-2)' }}>
              {t('gen_mode_passphrase')}
            </button>
            <button
              disabled
              style={{ padding: '6px 14px', borderRadius: 4, fontSize: 12, color: 'var(--text-4)' }}>
              {t('gen_mode_pin')}
            </button>
          </div>

          {mode === 'password' && <div className="field-group" style={{ background: 'transparent', border: 'none' }}>
            <div className="slider-row">
              <div className="lab">{t('gen_length')}</div>
              <div className="val">{len}</div>
              <input type="range" min="8" max="64" value={len} onChange={e => setLen(+e.target.value)} />
            </div>
            <div className="toggle-grid" style={{ marginTop: 16 }}>
              <Toggle on={lower} set={setLower} lab={t('gen_lower')} sub="a b c d e f" />
              <Toggle on={upper} set={setUpper} lab={t('gen_upper')} sub="A B C D E F" />
              <Toggle on={numbers} set={setNums} lab={t('gen_numbers')} sub="2 3 4 5 6 7" />
              <Toggle on={symbols} set={setSyms} lab={t('gen_symbols')} sub="! @ # $ % ^" />
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn sm">{t('gen_avoid_amb')}</button>
              <button className="btn sm">{t('gen_avoid_rep')}</button>
              <button className="btn sm">{t('gen_pronounce')}</button>
            </div>
          </div>}

          {mode === 'passphrase' && <div className="field-group" style={{ background: 'transparent', border: 'none' }}>
            <div className="slider-row">
              <div className="lab">{t('gen_words')}</div>
              <div className="val">{words}</div>
              <input type="range" min="3" max="10" value={words} onChange={e => setWords(+e.target.value)} />
            </div>
            <div className="toggle-grid" style={{ marginTop: 16 }}>
              <Toggle on={true} set={()=>{}} lab={t('gen_eff')} sub={t('gen_eff_sub')} />
              <Toggle on={false} set={()=>{}} lab={t('gen_cap')} sub={t('gen_cap_sub')} />
            </div>
          </div>}
        </div>
      </div>

      <div className="gen-right">
        <h3 className="section-title">{t('gen_analysis')}</h3>
        <div className="strength" style={{ background: 'var(--bg)' }}>
          <div className="row">
            <div className="score mono">{strength}<span style={{color:'var(--text-3)', fontSize:16}}>/100</span></div>
            <div className={"bar " + (strength<40?'weak':strength<70?'med':'')}><span style={{ width: strength + '%' }}/></div>
          </div>
          <div className="meta">
            <span>{t('meta_entropy')} <b>{Math.round((pw?.length||0) * (mode==='passphrase' ? 12.9 : 6))} bits</b></span>
            <span>{t('meta_crack')} <b>{strength>85 ? '10⁴⁵ y' : strength>70 ? '12,000 y' : '3 d'}</b></span>
          </div>
        </div>

        <h3 className="section-title" style={{ marginTop: 24 }}>{t('gen_recent')}</h3>
        <div className="panel" style={{ background: 'var(--bg)' }}>
          <div className="panel-body">
            {history.map((h, i) => (
              <div key={i} className="panel-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <div className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.pw}</div>
                <button className="btn icon sm" onClick={() => gCp(h.pw, toast, t('lbl_password'))}><Ig.Copy size={12}/></button>
              </div>
            ))}
            {!history.length && <div className="empty" style={{ padding: 20 }}>{t('gen_recent_empty')}</div>}
          </div>
        </div>

        <h3 className="section-title" style={{ marginTop: 24 }}>{t('gen_tips')}</h3>
        <ul className="mono" style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>
          <li>{t('gen_tip_1')}</li>
          <li>{t('gen_tip_2')}</li>
          <li>{t('gen_tip_3')}</li>
        </ul>
      </div>
    </div>
  );
}

function Toggle({ on, set, lab, sub }) {
  return (
    <div className="toggle" onClick={() => set(!on)}>
      <div className="l">
        <div className="lab">{lab}</div>
        <div className="sub">{sub}</div>
      </div>
      <div className={"switch " + (on ? 'on' : '')}></div>
    </div>
  );
}

window.ZPASS_Generator = Generator;

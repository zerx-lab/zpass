// Tweaks panel
const { useState: twS, useEffect: twE } = React;
const Itw = window.ZPASS_ICONS;
const { useI18n: twUseI18n } = window.ZPASS_I18N;

function Tweaks({ theme, setTheme, density, setDensity, body, setBody, lang, setLang }) {
  const [open, setOpen] = twS(false);
  const [hostEnabled, setHostEnabled] = twS(false);
  const { t } = twUseI18n();

  twE(() => {
    const onMsg = (e) => {
      if (e.data?.type === '__activate_edit_mode') { setOpen(true); setHostEnabled(true); }
      else if (e.data?.type === '__deactivate_edit_mode') { setOpen(false); setHostEnabled(false); }
    };
    window.addEventListener('message', onMsg);
    window.parent?.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const persist = (edits) => window.parent?.postMessage({ type: '__edit_mode_set_keys', edits }, '*');

  if (!open && !hostEnabled) {
    return (
      <button className="tweaks-toggle" onClick={() => setOpen(true)}>
        <Itw.Settings size={13} /> {t('tw_title')}
      </button>
    );
  }
  if (!open) return null;

  return (
    <div className="tweaks-panel">
      <div className="tweaks-head">
        <Itw.Settings size={14} />
        <h4>{t('tw_title')}</h4>
        <div className="spacer"/>
        <button className="btn icon sm" onClick={() => setOpen(false)}><Itw.Chevron size={12} style={{ transform: 'rotate(90deg)' }}/></button>
      </div>
      <div className="tweaks-body">
        <div className="tw-row">
          <div className="lab">{t('tw_lang')}</div>
          <div className="tw-seg">
            <button className={lang==='en' ? 'on':''} onClick={() => { setLang('en'); persist({ lang: 'en' }); }}>English</button>
            <button className={lang==='zh' ? 'on':''} onClick={() => { setLang('zh'); persist({ lang: 'zh' }); }}>简体中文</button>
          </div>
        </div>

        <div className="tw-row">
          <div className="lab">{t('tw_theme')}</div>
          <div className="tw-seg">
            <button className={theme==='dark' ? 'on':''} onClick={() => { setTheme('dark'); persist({ theme: 'dark' }); }}>{t('tw_dark')}</button>
            <button className={theme==='light' ? 'on':''} onClick={() => { setTheme('light'); persist({ theme: 'light' }); }}>{t('tw_light')}</button>
          </div>
        </div>

        <div className="tw-row">
          <div className="lab">{t('tw_density')}</div>
          <div className="tw-seg">
            <button className={density==='compact' ? 'on':''} onClick={() => { setDensity('compact'); persist({ density: 'compact' }); }}>{t('tw_compact')}</button>
            <button className={density==='normal' ? 'on':''} onClick={() => { setDensity('normal'); persist({ density: 'normal' }); }}>{t('tw_normal')}</button>
            <button className={density==='comfy' ? 'on':''} onClick={() => { setDensity('comfy'); persist({ density: 'comfy' }); }}>{t('tw_comfy')}</button>
          </div>
        </div>

        <div className="tw-row">
          <div className="lab">{t('tw_body')}</div>
          <div className="tw-seg">
            <button className={body==='sans' ? 'on':''} onClick={() => { setBody('sans'); persist({ body: 'sans' }); }}>{t('tw_sans')}</button>
            <button className={body==='mono' ? 'on':''} onClick={() => { setBody('mono'); persist({ body: 'mono' }); }}>{t('tw_mono')}</button>
          </div>
        </div>

        <div className="mono" style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
          {t('tw_hint')}
        </div>
      </div>
    </div>
  );
}

window.ZPASS_Tweaks = Tweaks;

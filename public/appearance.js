(() => {
  const palettes = { white: ['#f7f9fa','#ffffff'], gray: ['#e7e9ed','#f3f4f6'], dim: ['#15202b','#1e2b38'], dark: ['#000000','#111214'], paper: ['#f8f9f5','#ffffff'] };
  const accents = ['#1d9bf0','#256647','#7856ff','#f08720','#d94380','#b59b19'];
  const hex = value => /^#[0-9a-f]{6}$/i.test(value || '');
  const luminance = color => { const rgb = color.slice(1).match(/../g).map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
  const ink = color => luminance(color) > .179 ? '#0f1419' : '#f1f5f9';
  const mix = (a,b,t) => '#' + [1,3,5].map(i => Math.round(parseInt(a.slice(i,i+2),16)*t+parseInt(b.slice(i,i+2),16)*(1-t)).toString(16).padStart(2,'0')).join('');
  function readable(accent,bg) { const contrast=c=>(Math.max(luminance(c),luminance(bg))+.05)/(Math.min(luminance(c),luminance(bg))+.05); let result=accent; const toward=ink(bg); for(let i=0;i<10 && contrast(result)<4.5;i++)result=mix(result,toward,.8);return result; }
  let state = { mode:'paper', accent:'#256647', background:null, surface:null };
  try { const saved=JSON.parse(localStorage.getItem('threadly-appearance')||'null'); if (saved) state={...state,...saved}; } catch {}
  function colors() {
    const base = palettes[state.mode] || palettes.paper;
    const background = hex(state.background) ? state.background : base[0], surface = hex(state.surface) ? state.surface : base[1], accent = hex(state.accent) ? state.accent : '#256647';
    const text = ink(surface), bodyText=ink(background);
    return { background,surface,accent,text,bodyText,muted:mix(text,surface,.68),line:mix(text,surface,.16),soft:mix(accent,surface,.09),accentInk:ink(accent),link:readable(accent,background),cardLink:readable(accent,surface) };
  }
  function apply(patch={}, save=true) {
    state={...state,...patch}; if (!palettes[state.mode]) state.mode='paper';
    const c=colors(), root=document.documentElement;
    const values={'--paper':c.background,'--surface':c.surface,'--green':c.accent,'--ink':c.bodyText,'--card-ink':c.text,'--muted':c.muted,'--line':c.line,'--soft':c.soft,'--accent-ink':c.accentInk,'--link':c.link,'--card-link':c.cardLink};
    for(const [key,value] of Object.entries(values)) root.style.setProperty(key,value);
    root.style.colorScheme=luminance(c.background)>.35?'light':'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',c.background);
    if(save)try{localStorage.setItem('threadly-appearance',JSON.stringify(state))}catch{}
  }
  window.ThreadlyAppearance={apply,colors,get:()=>({...state}),palettes,accents}; apply({},false);
  window.addEventListener('storage',e=>{if(e.key==='threadly-appearance'){try{state=JSON.parse(e.newValue)||{mode:'paper',accent:'#256647'};apply({},false)}catch{}}});
})();

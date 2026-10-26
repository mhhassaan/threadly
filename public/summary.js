// Coherent extraction: select paragraph spans, preserve context and complete sentences.
const size = value => Array.from(value).length;
const dependent = /^(?:this|these|those|it|its|they|their|such|however|therefore|instead|as a result|for example|but|yet)\b/i;
export function sentenceParts(text) {
  const raw = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(x => x.segment.trim()).filter(Boolean);
  const result = [];
  for (let i = 0; i < raw.length; i++) {
    let value = raw[i];
    while (i + 1 < raw.length && /(?:\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|\b(?:e\.g|i\.e|U\.S))\.$/.test(value)) value += ' ' + raw[++i];
    result.push(value);
  }
  return result;
}
function pack(sentences, preferred = 270) {
  const chunks=[]; for(const sentence of sentences) { if(chunks.length && dependent.test(sentence)) chunks[chunks.length-1]+=' '+sentence; else chunks.push(sentence); }
  const result = []; let current = '';
  for (const sentence of chunks) {
    if (current && size(current + ' ' + sentence) > preferred) { result.push(current); current = ''; }
    current += (current ? ' ' : '') + sentence;
  }
  if (current) result.push(current);
  return result;
}
export function summarize(text, level = 'balanced', limit = 'auto') {
  const clean = text.replace(/\r/g, '').replace(/^[#>*]+\s*/gm, '').trim();
  if (!clean) return [];
  const ratio = { quick: .28, balanced: .52, detailed: .82 }[level] || .52;
  const cap = limit === 'auto' ? ({ quick: 8, balanced: 16, detailed: 32 }[level] || 16) : Math.max(1, Math.min(100, Number(limit) || 16));
  let paragraphs = clean.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // A standalone title is not a complete opening thought.
  if (paragraphs.length > 1 && size(paragraphs[0]) < 130 && !/[.!?。！？][”’"']?$/.test(paragraphs[0])) paragraphs.shift();
  let groups = paragraphs.map(sentenceParts);
  if (groups.length === 1 && groups[0].length > 5) { const all = groups[0]; groups = []; for (let i = 0; i < all.length; i += 3) groups.push(all.slice(i, i + 3)); }
  const stop = new Set('the and that this with from have your their they were into about which when will would could should there these those been are for not you our its'.split(' '));
  const terms = s => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !stop.has(w));
  const frequency = new Map(); for (const g of groups) for (const w of new Set(terms(g.join(' ')))) frequency.set(w, (frequency.get(w) || 0) + 1);
  const units = groups.map((sentences, index) => {
    const max = level === 'quick' ? 2 : level === 'detailed' ? 6 : 3;
    // A contiguous opening span retains the setup for pronouns, contrasts and examples.
    const span = sentences.slice(0, max);
    for(let next=max;next<sentences.length && dependent.test(sentences[next]);next++) span.push(sentences[next]);
    const words = terms(span.join(' '));
    const score = words.reduce((sum, w) => sum + Math.log(1 + frequency.get(w)), 0) / Math.max(1, Math.sqrt(words.length));
    return { index, span, score, posts: pack(span) };
  });
  if (!units.length) return [];
  const chosen = new Set(); let used = 0;
  function add(index) {
    if (index < 0 || chosen.has(index)) return true;
    let begin=index; while(begin>0 && dependent.test(units[begin].span[0]) && !chosen.has(begin-1)) begin--;
    const required=Array.from({length:index-begin+1},(_,i)=>begin+i);
    const cost = required.reduce((n, i) => n + (chosen.has(i) ? 0 : units[i].posts.length), 0);
    if (used + cost > cap) return false;
    for (const i of required) if (!chosen.has(i)) { chosen.add(i); used += units[i].posts.length; }
    return true;
  }
  add(0);
  // Keep the closing perspective, then cover the most informative intervening ideas.
  const goal = Math.max(Math.min(2, units.length), Math.ceil(units.length * ratio));
  if (units.length > 1) add(units.length - 1);
  while (chosen.size < goal) {
    const candidates = units.filter(u => !chosen.has(u.index)).map(u => ({ ...u, priority: u.score + Math.min(...[...chosen].map(i => Math.abs(i - u.index)), units.length) * 1.5 })).sort((a, b) => b.priority - a.priority);
    let added = false; for (const candidate of candidates) if (add(candidate.index)) { added = true; break; }
    if (!added) break;
  }
  // If one exceptionally long opening exceeds the requested post count, retain complete sentences.
  if (!chosen.size) return units[0].posts.slice(0, cap);
  return [...chosen].sort((a, b) => a - b).flatMap(i => units[i].posts);
}

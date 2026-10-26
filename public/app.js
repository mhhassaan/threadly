import { summarize } from '/summary.js';
import { createThreadImage } from '/export.js';
const $ = id => document.getElementById(id);
// Keyboard navigation stays instantaneous; pointer actions can use brief feedback.
let inputMethod = 'keyboard';
let arrivalAnimation = null, arrivalPlayed = false, keyboardUsed = false;
document.documentElement.dataset.motionInput = inputMethod;
document.addEventListener('pointerdown', () => { inputMethod='pointer'; document.documentElement.dataset.motionInput=inputMethod; }, true);
document.addEventListener('keydown', () => { keyboardUsed=true; arrivalAnimation?.cancel(); inputMethod='keyboard'; document.documentElement.dataset.motionInput=inputMethod; }, true);
const readerToken = new URLSearchParams(location.search).get('reader');
const isReader = new URLSearchParams(location.search).has('reader');
let mode = 'text', depth = 'balanced', posts = [], title = '', sourceUrl = '';
let latestRecord = null, busy = false;
let sourceProfile = null, articleMedia = [], interactions = {}, threadId = null;
const selectedPosts = new Set();
let lastExportUrl = null;
const readerWindows = new Map();
const readerCacheKey = 'threadly-reader-' + readerToken;
function loadSaved() {
  try { const data = JSON.parse(localStorage.getItem('threadly-library') || '[]'); return Array.isArray(data) ? data.filter(validRecord) : []; }
  catch { return []; }
}
function validRecord(data) { return data && typeof data.title === 'string' && Array.isArray(data.posts) && data.posts.length > 0 && data.posts.every(p => typeof p === 'string') && data.posts.length <= 100; }
let saved = loadSaved();
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800); }
function error(message) { $('error').hidden = !message; $('error').textContent = message; }
function updateSavedCount() { $('savedCount').textContent = saved.length; }
function wordCount() { const n = $('sourceText').value.trim().split(/\s+/).filter(Boolean).length; $('wordCount').textContent = n.toLocaleString() + ' words'; }
function switchMode(next) {
  mode = next;
  for (const key of ['text', 'url', 'file']) { $(key + 'Pane').hidden = key !== next; $(key + 'Tab').classList.toggle('selected', key === next); $(key + 'Tab').setAttribute('aria-selected', String(key === next)); $(key + 'Tab').tabIndex = key === next ? 0 : -1; }
  error('');
}
const example=`The quiet power of paying attention

Attention is one of the most valuable resources we have. Every notification, open tab, and unfinished task asks for a small piece of it. Yet paying attention is more than a productivity technique: it shapes the things we notice, remember, and understand.

Switching between tasks carries a hidden cost. Part of our attention stays with the previous task even after we move on. This residue makes it harder to engage deeply with a new idea. Grouping similar activities and protecting uninterrupted time can help reduce that friction.

Deep reading gives ideas room to connect. When we slow down, we can question an argument, notice a surprising detail, and relate new information to something we already know. A short summary is useful for orientation, but a complex argument may still deserve a full read.

Small changes can make focused work easier. Put the phone out of reach, close tabs that are unrelated to the current task, and choose one question to explore. The goal is not to eliminate distraction forever. It is to make returning to the work a little easier.

Breaks matter too. A walk without headphones or a quiet moment away from a screen can create space for reflection. Rest is not simply the absence of work; it can be part of how we process what we have learned.

Paying attention is ultimately a choice about what receives our time. Start with a modest experiment: protect twenty minutes for one meaningful activity. Notice what changes when you give an idea enough space to unfold.`;

const tweetIcon = name => {
  const paths = { reply:'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l2.3-3.1A8.5 8.5 0 1 1 21 11.5Z', retweet:'m4 8 3-3 3 3M7 5v11a2 2 0 0 0 2 2h4m7-2-3 3-3-3m3 3V8a2 2 0 0 0-2-2h-4', like:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z', share:'M12 16V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6', copy:'M9 9h12v12H9zM15 5V3H3v12h2', image:'M3 3h18v18H3zM3 16l5-5 4 4 3-3 6 6M8 7h.01', bookmark:'M6 3h12v18l-6-4-6 4z', user:'M20 21v-2a8 8 0 0 0-16 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0' };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[name] + '"/></svg>';
};
function record() { return { id:threadId, source:sourceProfile, media:articleMedia, interactions, title, posts: [...posts], sourceUrl, date: new Date().toLocaleDateString() }; }
function cacheReader() { try { sessionStorage.setItem(readerCacheKey, JSON.stringify(record())); } catch {} }
function render() {
  const root = $('thread'); root.replaceChildren();
  posts.forEach((text, i) => {
    const row = document.createElement('article'); row.className = 'post' + (i === 0 ? ' first-post' : '');
    row.innerHTML = '<div class="avatar"></div><div class="post-body"><div class="author"><strong class="source-name"></strong><span class="handle"></span><span class="tweet-time">· now</span><label class="post-select"><input type="checkbox"><span class="sr-only">Select tweet</span></label></div>' + (i ? '<div class="replying">Replying to <span class="reply-handle"></span></div>' : '') + '<div class="posttext" contenteditable="true" role="textbox" spellcheck="false"></div><div class="tweet-meta"><span class="postnum"></span><span class="chars"></span></div><div class="post-actions"><button class="reply-post" aria-label="Reply to tweet">' + tweetIcon('reply') + '<span class="action-count"></span></button><button class="repost-post" aria-label="Repost tweet locally" aria-pressed="false">' + tweetIcon('retweet') + '<span class="action-count"></span></button><button class="like-post" aria-label="Like tweet" aria-pressed="false">' + tweetIcon('like') + '<span class="action-count"></span></button><button class="bookmark-post" aria-label="Bookmark tweet" aria-pressed="false">' + tweetIcon('bookmark') + '</button><button class="copy-post" title="Copy this tweet" aria-label="Copy this tweet">' + tweetIcon('copy') + '</button><button class="share-post" title="Share this tweet" aria-label="Share this tweet">' + tweetIcon('share') + '</button><button class="image-post" title="Save tweet as image" aria-label="Save tweet as image">' + tweetIcon('image') + '</button></div></div>';
    decoratePost(row,i);
    row.querySelector('.postnum').textContent = (i + 1) + '/' + posts.length;
    const field = row.querySelector('.posttext'); field.textContent = text; field.setAttribute('aria-label', 'Edit post ' + (i + 1));
    const count = row.querySelector('.chars');
    const updateCount = () => { const n = Array.from(numbered(i)).length; count.textContent = n > 280 ? n + ' characters · complete thought' : n + '/280'; count.title = n > 280 ? 'Kept together to preserve a complete sentence. Edit if you need a shorter tweet.' : ''; };
    field.oninput = () => { posts[i] = field.innerText; updateCount(); cacheReader(); };
    row.querySelector('.copy-post').onclick = () => copy(numbered(i));
    row.querySelector('.share-post').onclick = async () => { try { if (navigator.share) await navigator.share({ title: 'Threadly', text: numbered(i) }); else await copy(numbered(i)); } catch (e) { if (e.name !== 'AbortError') toast('Sharing unavailable. Try copying this tweet.'); } };
    const checkbox = row.querySelector('.post-select input'); checkbox.setAttribute('aria-label', 'Select tweet ' + (i + 1)); checkbox.checked = selectedPosts.has(i); row.classList.toggle('is-selected', checkbox.checked); checkbox.onchange = () => { if (checkbox.checked) selectedPosts.add(i); else selectedPosts.delete(i); row.classList.toggle('is-selected', checkbox.checked); updateSelection(); };
    row.querySelector('.image-post').onclick = () => exportImages([i], row.querySelector('.image-post'));
    updateCount(); root.append(row);
  });
  $('readerTitle').textContent = title || 'Your reading thread';
  document.title = (title || 'Your thread') + ' — Threadly';
  $('readerDescription').textContent = 'The ideas that matter, with room for context.';
  $('threadInfo').textContent = posts.length + ' tweets · ' + Math.max(1, Math.ceil(posts.join(' ').split(/\s+/).length / 220)) + ' min read';
  $('readerState').hidden = true; $('readerTools').hidden = false; $('readerFoot').hidden = false; $('selectionBar').hidden = false; updateSelection();
  $('sourceLink').hidden = true;
  if (sourceUrl) { try { const url = new URL(sourceUrl); if (['http:', 'https:'].includes(url.protocol)) { $('sourceLink').href = url.href; $('sourceLink').hidden = false; } } catch {} }
}
function numbered(i) { return posts[i] + ' ' + (i + 1) + '/' + posts.length; }
function fullText() { return title + '\n\n' + posts.map((_, i) => numbered(i)).join('\n\n') + (sourceUrl ? '\n\nSource: ' + sourceUrl : ''); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Clipboard unavailable. Download your thread instead.'); } }
function showReaderProblem(message) {
  $('readerTitle').textContent = 'Your reading space'; $('readerDescription').textContent = 'Start with a source to make it yours.';
  $('readerState').hidden = false; $('readerState').replaceChildren(); const heading = document.createElement('h2'); heading.textContent = 'No thread here yet'; const p = document.createElement('p'); p.textContent = message;
  const link = document.createElement('a'); link.href = '/'; link.className = 'secondary'; link.textContent = 'Create a thread'; $('readerState').append(heading, p, link); $('threadInfo').textContent = 'Ready when you are';
}
function receiveRecord(data) { if (!validRecord(data)) return; selectedPosts.clear(); title = data.title; posts = [...data.posts]; sourceUrl = data.sourceUrl || ''; threadId=data.id||crypto.randomUUID(); sourceProfile=data.source||null; articleMedia=Array.isArray(data.media)?data.media:[]; interactions=data.interactions&&typeof data.interactions==='object'?data.interactions:{}; render(); cacheReader(); animateArrival('forward'); }
// Animate the destination once, after content exists; never delay navigation or focus.
function animateArrival(direction) {
  if (arrivalPlayed) return;
  arrivalPlayed=true;
  if (keyboardUsed || new URLSearchParams(location.search).get('motion') !== direction || performance.getEntriesByType('navigation')[0]?.type !== 'navigate') return;
  const target=document.querySelector(isReader?'.reading-window':'.dashboard');
  if (!target?.animate) return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start={opacity:0};
  if (!reduced) start.transform=`translateY(${direction==='back'?-8:8}px)`;
  arrivalAnimation=target.animate([start,{opacity:1,transform:'none'}],{duration:reduced?120:220,easing:getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim()||'ease-out'});
}
// Return links carry the interaction intent to the destination, including modified clicks.
document.addEventListener('click', event => {
  if (!isReader) return;
  const link=event.target.closest('a[href]');
  if (!link || link.origin!==location.origin || link.pathname!=='/') return;
  const destination=new URL(link.href);
  if (destination.searchParams.has('reader')) return;
  destination.searchParams.set('motion',inputMethod==='pointer'?'back':'none'); link.href=destination.href;
}, true);
if (!isReader) animateArrival('back');
// Open during the click gesture so asynchronous article imports do not trigger popup blocking.
function launchReader(data = null) {
  const token = crypto.randomUUID(); const url = new URL('/', location.href); url.searchParams.set('reader', token);
  url.searchParams.set('motion', inputMethod==='pointer'?'forward':'none');
  const win = window.open(url.href, '_blank');
  const entry = { win, data, token, motionAllowed: inputMethod==='pointer' }; readerWindows.set(token, entry);
  return entry;
}
function showResult(blocked, allowMotion=inputMethod==='pointer') { $('resultNotice').dataset.motionInput=allowMotion?'pointer':'keyboard'; $('resultNotice').hidden = false; $('resultHint').textContent = blocked ? 'Your browser blocked the new window. Select Open thread to try again.' : 'Your source stays here for your next read.'; }
window.addEventListener('message', event => {
  if (event.origin !== location.origin || !event.data) return;
  if (isReader && event.data.type === 'threadly:result') { if (event.source === window.opener && event.data.type === 'threadly:result' && event.data.token === readerToken) receiveRecord(event.data.record); return; }
  if (event.data.type !== 'threadly:ready') return;
  const entry = readerWindows.get(event.data.token);
  if (entry && entry.win === event.source && entry.data) entry.win.postMessage({ type: 'threadly:result', token: event.data.token, record: entry.data }, location.origin);
});
async function generate() {
  if (busy) return; error(''); let text = $('sourceText').value.trim(); const url = $('articleUrl').value.trim();
  if (mode === 'url') { try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) throw Error(); } catch { error('Add a valid article link, starting with https://.'); $('articleUrl').focus(); return; } }
  else if (text.split(/\s+/).filter(Boolean).length < 30) { error('Add at least 30 words for a thread with enough context.'); if (mode === 'file') $('chooseFile').focus(); else $('sourceText').focus(); return; }
  busy = true; const button = $('generate'); button.disabled = true; button.setAttribute('aria-busy', 'true'); button.firstElementChild.textContent = mode === 'url' ? 'Reading your article…' : 'Creating your thread…'; $('resultNotice').hidden = true;
  const entry = launchReader();
  try {
    let nextTitle = text.split('\n')[0].slice(0, 100), nextUrl = '', nextSource=null, nextMedia=textMedia(text);
    const attributed=text.match(/^Source:\s*(https?:\/\/\S+)/im);if(attributed&&remoteUrl(attributed[1])){const u=new URL(attributed[1]);nextUrl=u.href;nextSource={name:u.hostname.replace(/^www\./,''),handle:u.hostname.replace(/^www\./,''),url:u.origin,icon:new URL('/favicon.ico',u).href};}
    if (mode === 'url') { const response = await fetch('/api/article', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }); const data = await response.json(); if (!response.ok) throw Error(data.error); text = data.text; nextTitle = data.title; nextUrl = data.url; nextSource=data.source; nextMedia=data.media||[]; }
    if (text.split(/\s+/).filter(Boolean).length < 30) throw Error('We could not find enough article text. Paste the source text instead.');
    latestRecord = { title: nextTitle || 'Your reading thread', posts: summarize(text.replace(/!\[[^\]]*\]\([^)]+\)/g,''), depth, $('length').value), sourceUrl: nextUrl };
    latestRecord.id=crypto.randomUUID();latestRecord.source=nextSource;latestRecord.media=assignMedia(nextMedia,latestRecord.posts,text);latestRecord.interactions={};
    entry.data = latestRecord;
    if (entry.win && !entry.win.closed) entry.win.postMessage({ type: 'threadly:result', token: entry.token, record: latestRecord }, location.origin);
    showResult(!entry.win || entry.win.closed, entry.motionAllowed); toast('Your thread is ready');
  } catch (e) { if (entry.win && !entry.win.closed) entry.win.close(); error(e.message || 'Something went wrong. Please try again.'); }
  finally { busy = false; button.disabled = false; button.setAttribute('aria-busy', 'false'); button.firstElementChild.textContent = 'Create my thread'; }
}
$('reopenReader').onclick = () => { if (!latestRecord) return; const entry = launchReader(latestRecord); showResult(!entry.win, entry.motionAllowed); };
for (const key of ['text', 'url', 'file']) {
  $(key + 'Tab').onclick = () => switchMode(key);
  $(key + 'Tab').onkeydown = event => { const keys = ['text', 'url', 'file']; let index = keys.indexOf(key); if (event.key === 'ArrowRight') index = (index + 1) % 3; else if (event.key === 'ArrowLeft') index = (index + 2) % 3; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = 2; else return; event.preventDefault(); switchMode(keys[index]); $(keys[index] + 'Tab').focus(); };
}
$('sourceText').oninput = wordCount;
$('clear').onclick = () => { $('sourceText').value = ''; wordCount(); $('sourceText').focus(); };
document.querySelectorAll('[data-depth]').forEach(button => button.onclick = () => { depth = button.dataset.depth; document.querySelectorAll('[data-depth]').forEach(other => { other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button)); }); });
$('generate').onclick = generate;
$('articleUrl').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); generate(); } };
$('sourceText').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); } };
$('example').onclick = () => { $('sourceText').value = example; wordCount(); switchMode('text'); $('sourceText').focus(); toast('Example added. Choose your depth, then create a thread.'); };
async function loadFile(file) {
  if (!file) return; error('');
  if (file.size > 1000000) { error('Choose a file smaller than 1 MB.'); return; }
  if (!/\.(txt|md)$/i.test(file.name)) { error('Choose a text (.txt) or Markdown (.md) file.'); return; }
  try { const text = await file.text(); if (text.length > 100000) throw Error('Use a file containing up to 100,000 characters.'); $('sourceText').value = text; $('fileName').textContent = file.name; wordCount(); switchMode('text'); toast('File loaded. Your text is ready to turn into a thread.'); } catch (e) { error(e.message); }
}
$('chooseFile').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
$('dropZone').ondragover = e => { e.preventDefault(); $('dropZone').classList.add('drag-over'); };
$('dropZone').ondragleave = () => $('dropZone').classList.remove('drag-over');
$('dropZone').ondrop = e => { e.preventDefault(); $('dropZone').classList.remove('drag-over'); loadFile(e.dataTransfer.files[0]); };
function persist() { try { localStorage.setItem('threadly-library', JSON.stringify(saved)); updateSavedCount(); return true; } catch { toast('Browser storage unavailable. Download your thread instead.'); return false; } }
$('save').onclick = () => { saved = loadSaved(); if (saved.some(s => s.posts.join('') === posts.join(''))) { toast('Already in your saved threads'); return; } const item = { ...record(), id: crypto.randomUUID() }; saved.unshift(item); if (persist()) toast('Saved on this device'); else saved.shift(); };
$('copyAll').onclick = () => copy(fullText());
$('download').onclick = () => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([fullText()], { type: 'text/plain;charset=utf-8' })); link.download = 'threadly-thread.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast('Thread downloaded'); };
function modal(heading) { $('modal').dataset.motionInput=inputMethod; $('modalTitle').textContent = heading; $('modalBody').replaceChildren(); $('modal').showModal(); }
$('closeModal').onclick = () => $('modal').close();
$('modal').onclick = e => { if (e.target === $('modal')) { const r = $('modal').getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('modal').close(); } };
$('library').onclick = () => {
  saved = loadSaved(); updateSavedCount(); modal('Your saved threads');
  if (!saved.length) { $('modalBody').textContent = 'Your reading list starts here. Save a thread from its reading window to find it here later. Threads stay on this device.'; return; }
  for (const item of saved) {
    const row = document.createElement('div'); row.className = 'saved-item'; const open = document.createElement('button'); open.className = 'saved-open'; open.textContent = item.title;
    const meta = document.createElement('small'); meta.textContent = item.posts.length + ' tweets · ' + (item.date || 'Saved on this device'); open.append(meta);
    open.onclick = () => { latestRecord = item; const entry = launchReader(item); $('modal').close(); if (!isReader) showResult(!entry.win, entry.motionAllowed); else if (!entry.win) receiveRecord(item); };
    const del = document.createElement('button'); del.className = 'delete-saved'; del.textContent = '×'; del.setAttribute('aria-label', 'Delete saved thread ' + item.title);
    del.onclick = () => { const previous = [...saved]; saved = loadSaved().filter(s => s.id !== item.id); if (persist()) { row.remove(); if (!saved.length) $('modalBody').textContent = 'No saved threads yet.'; } else saved = previous; };
    row.append(open, del); $('modalBody').append(row);
  }
};
$('about').onclick = () => {
  modal('A little less reading. A lot more clarity.');
  for (const line of ['Add a source: paste text, link a public article, or upload a text or Markdown file.', 'Choose your depth. Quick read keeps the essentials; Balanced adds context; Deep dive leaves room for detail.', 'Your thread opens in a separate reading window. Edit, copy, download, or save it there. Your original source stays on the dashboard.', 'Threadly selects connected passages and keeps complete sentences in source order. Longer thoughts stay together instead of being cut at a character limit. It does not use generative AI. A summary may leave out context; return to the source when the details matter.', 'Likes, reposts, bookmarks, and replies are local interactions. They are not published to Twitter/X. Bookmarking or replying saves the thread on this device.', 'Article media and publisher icons appear when available; unsupported embeds link back to their source. PNG exports include available static images.', 'Pasted text stays in your browser. Article links and images are fetched by the server. Saved threads stay on this device.']) { const p = document.createElement('p'); p.textContent = line; $('modalBody').append(p); }
};
$('newThread').onclick = e => { if (!isReader) { e.preventDefault(); $('sourceText').focus(); } };
window.addEventListener('storage', e => { if (e.key === 'threadly-library') { saved = loadSaved(); updateSavedCount(); } });
updateSavedCount();
if (isReader) {
  $('newThread').classList.remove('nav-active'); let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(readerCacheKey) || 'null'); } catch {}
  if (validRecord(cached)) receiveRecord(cached);
  else if (window.opener) window.opener.postMessage({ type: 'threadly:ready', token: readerToken }, location.origin);
  else showReaderProblem('This window has no thread yet. Create one from the dashboard, or open a saved thread.');
}


function updateSelection() {
  $('selectionCount').textContent = selectedPosts.size ? selectedPosts.size + ' selected' : 'Select tweets for images';
  $('exportSelected').disabled = !selectedPosts.size;
}
$('selectAll').onclick = () => { posts.forEach((_,i)=>selectedPosts.add(i)); render(); };
$('clearSelection').onclick = () => { selectedPosts.clear(); render(); };
$('exportSelected').onclick = () => exportImages([...selectedPosts].sort((a,b)=>a-b), $('exportSelected'));
async function exportImages(indices, button) {
  if (!indices.length) { toast('Select at least one tweet.'); return; }
  const oldText = button?.textContent;
  if (button) { button.disabled=true; button.setAttribute('aria-busy','true'); if (!button.classList.contains('image-post')) button.textContent='Creating image…'; }
  try {
    const result = await createThreadImage({posts:[...posts],title,sourceUrl,source:sourceProfile,media:articleMedia,indices,theme:window.ThreadlyAppearance.colors()});
    if(lastExportUrl)URL.revokeObjectURL(lastExportUrl);
    lastExportUrl=URL.createObjectURL(result.blob);
    if(!$('modal').open)modal('Your image is ready');
    $('modalBody').querySelector('.export-result')?.remove();
    const preview=document.createElement('div');preview.className='export-result';
    const heading=document.createElement('strong');heading.textContent='Your image is ready';preview.append(heading);
    if(result.blob.type==='image/png'){const image=document.createElement('img');image.src=lastExportUrl;image.alt='Preview of the exported '+indices.length+' tweet'+(indices.length===1?'':'s');preview.append(image);}
    const link=document.createElement('a');link.href=lastExportUrl;link.download=result.filename;link.className='secondary';link.textContent=result.filename.endsWith('.zip')?'Download PNG pages (ZIP)':'Download PNG';preview.append(link);$('modalBody').append(preview);link.click();
    toast(result.warnings?'Image downloaded · some source images were unavailable':result.filename.endsWith('.zip')?'Image pages downloaded as a ZIP':'Image downloaded');
  } catch(e) { toast(e.message || 'Could not create the image. Try fewer tweets.'); }
  finally { if(button){button.disabled=false;button.setAttribute('aria-busy','false');if(!button.classList.contains('image-post'))button.textContent=oldText;} }
}
$('images').onclick = () => {
  modal('Save your thread as an image');
  const controls=document.createElement('div'); controls.className='image-export-options';
  controls.innerHTML='<p class="dialog-description">Your colors, your words. Export a clean PNG without editing controls.</p><fieldset class="export-scopes"><legend>What would you like to save?</legend><label><input type="radio" name="exportScope" value="all" checked> All tweets <span></span></label><label><input type="radio" name="exportScope" value="selected"> Selected tweets <span></span></label><label><input type="radio" name="exportScope" value="single"> One tweet</label></fieldset><div class="export-checklist" hidden></div><label class="single-tweet-picker" hidden>Choose a tweet <select></select></label><div class="export-theme-preview"><span class="mini-avatar">≋</span><div><strong>Threadly</strong><p>Exported in your current theme</p></div><button class="text-button" type="button">Change appearance</button></div><p class="export-note">Long threads become numbered PNG pages in one ZIP. Original tweet numbers are preserved.</p><button class="generate export-download">Download PNG</button>';
  $('modalBody').append(controls);
  const checklist=controls.querySelector('.export-checklist'),single=controls.querySelector('.single-tweet-picker'),select=single.querySelector('select'),download=controls.querySelector('.export-download');
  posts.forEach((text,i)=>{
    const label=document.createElement('label'),check=document.createElement('input'),span=document.createElement('span');check.type='checkbox';check.checked=selectedPosts.has(i);check.setAttribute('aria-label','Include tweet '+(i+1)+' in image');span.textContent=(i+1)+'. '+text.slice(0,100)+(text.length>100?'…':'');label.append(check,span);checklist.append(label);
    check.onchange=()=>{if(check.checked)selectedPosts.add(i);else selectedPosts.delete(i);sync();render();};
    const option=document.createElement('option');option.value=i;option.textContent='Tweet '+(i+1)+' of '+posts.length;select.append(option);
  });
  function scope(){return controls.querySelector('input[name="exportScope"]:checked').value;}
  function indices(){return scope()==='all'?posts.map((_,i)=>i):scope()==='single'?[Number(select.value)]:[...selectedPosts].sort((a,b)=>a-b);}
  function sync(){checklist.hidden=scope()!=='selected';single.hidden=scope()!=='single';download.disabled=!indices().length;download.textContent='Download '+indices().length+' tweet'+(indices().length===1?'':'s')+' as PNG';controls.querySelector('[value="all"]').parentElement.querySelector('span').textContent=posts.length;controls.querySelector('[value="selected"]').parentElement.querySelector('span').textContent=selectedPosts.size;}
  controls.querySelectorAll('[name="exportScope"]').forEach(radio=>radio.onchange=sync);select.onchange=sync;
  controls.querySelector('.export-theme-preview button').onclick=()=>{$('modal').close();showAppearance();};
  download.onclick=()=>exportImages(indices(),download);sync();
};
function showAppearance() {
  modal('Make yourself comfortable');
  const appearance=window.ThreadlyAppearance,state=appearance.get(),colors=appearance.colors();
  const content=document.createElement('div');content.className='appearance-controls';
  content.innerHTML='<p class="dialog-description">Choose your background and color palette. Changes apply to both windows and image exports.</p><fieldset class="theme-fieldset"><legend>Background</legend><div class="theme-presets"></div></fieldset><fieldset class="theme-fieldset"><legend>Accent color</legend><div class="accent-presets"></div></fieldset><fieldset class="theme-fieldset"><legend>Your own tones</legend><div class="custom-tones"><label>Page <input type="color" name="background"></label><label>Cards <input type="color" name="surface"></label><label>Accent <input type="color" name="accent"></label></div></fieldset><div class="theme-preview"><span class="mini-avatar">≋</span><div><strong>A little easier on the eyes.</strong><p>Your theme follows you into every thread.</p></div></div><div class="appearance-footer"><button class="secondary" id="resetAppearance">Reset to Paper</button><button class="copy-primary" id="doneAppearance">Done</button></div>';
  $('modalBody').append(content);
  const labels={white:'White',gray:'Gray',dim:'Dim',dark:'Dark',paper:'Paper'};
  for(const [mode,palette] of Object.entries(appearance.palettes)){
    const button=document.createElement('button');button.className='theme-preset';button.type='button';button.dataset.mode=mode;button.setAttribute('aria-pressed',String(state.mode===mode&&!state.background&&!state.surface));
    const sample=document.createElement('span');sample.style.background=palette[0];sample.style.borderColor=palette[1];sample.innerHTML='<i></i><i></i>';sample.querySelectorAll('i').forEach(line=>line.style.background=palette[1]==='#ffffff'?'#bdc8c0':'#657381');const text=document.createElement('strong');text.textContent=labels[mode];button.append(sample,text);button.onclick=()=>{appearance.apply({mode,background:null,surface:null});refresh();};content.querySelector('.theme-presets').append(button);
  }
  for(const [index,color] of appearance.accents.entries()){
    const button=document.createElement('button');button.className='accent-swatch';button.style.background=color;button.style.color='#fff';button.setAttribute('aria-label',['Blue','Green','Purple','Orange','Pink','Gold'][index]+' accent');button.setAttribute('aria-pressed',String(state.accent===color));button.dataset.color=color;button.onclick=()=>{appearance.apply({accent:color});refresh();};content.querySelector('.accent-presets').append(button);
  }
  function refresh(){const s=appearance.get(),c=appearance.colors();content.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===s.mode&&!s.background&&!s.surface)));content.querySelectorAll('[data-color]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.color===s.accent)));for(const key of ['background','surface','accent'])content.querySelector('input[name="'+key+'"]').value=c[key];}
  for(const key of ['background','surface','accent']){const input=content.querySelector('input[name="'+key+'"]');input.value=colors[key];input.oninput=()=>{appearance.apply({[key]:input.value});refresh();};}
  $('resetAppearance').onclick=()=>{appearance.apply({mode:'paper',accent:'#256647',background:null,surface:null});refresh();};$('doneAppearance').onclick=()=>$('modal').close();
}
$('appearance').onclick=showAppearance;

window.addEventListener('beforeunload',()=>{if(lastExportUrl)URL.revokeObjectURL(lastExportUrl);});
function remoteUrl(value) { try { if(typeof value!=='string'||!value)return '';const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:''; } catch{return '';} }
function mediaUrl(value) { const url=remoteUrl(value);return url?'/api/media?url='+encodeURIComponent(url):''; }
function assignMedia(items,thread,text) {
  const normalized=text.replace(/\s+/g,' '),positions=thread.map(p=>Math.max(0,normalized.indexOf(p.slice(0,60)))/Math.max(normalized.length,1));
  return items.filter(m=>remoteUrl(m.url)).map(item=>{const fraction=Number(item.position)||0;let index=0;positions.forEach((p,i)=>{if(p<=fraction)index=i;});return {...item,postIndex:index};});
}
function actionState(index) {
  const state=interactions[index];if(!state||typeof state!=='object')interactions[index]={liked:false,reposted:false,bookmarked:false,replies:[]};
  if(!Array.isArray(interactions[index].replies))interactions[index].replies=[];return interactions[index];
}
function storeInteractions(ensureSaved=false) {
  cacheReader();const library=loadSaved(),index=library.findIndex(s=>s.id===threadId);
  if(index<0&&!ensureSaved)return;
  if(index>=0)library[index]={...library[index],...record()};else library.unshift(record());
  try{localStorage.setItem('threadly-library',JSON.stringify(library));saved=library;updateSavedCount();}catch{toast('Could not save changes on this device.');}
}
function decoratePost(row,index) {
  const sourceName=sourceProfile?.name||'You',handle=sourceProfile?.handle?'@'+sourceProfile.handle:'@you';
  row.querySelector('.source-name').textContent=sourceName;row.querySelector('.handle').textContent=handle;const replying=row.querySelector('.reply-handle');if(replying)replying.textContent=handle;
  const avatar=row.querySelector('.avatar');avatar.innerHTML=tweetIcon('user');avatar.setAttribute('aria-label',sourceName+' profile picture');
  const icon=mediaUrl(sourceProfile?.icon);if(icon){const image=document.createElement('img');image.alt=sourceName;image.src=icon;image.referrerPolicy='no-referrer';image.onload=()=>avatar.classList.add('has-source-image');image.onerror=()=>{image.remove();avatar.classList.remove('has-source-image');};avatar.append(image);}
  const attachments=articleMedia.filter(item=>item.postIndex===index);
  if(attachments.length){const container=document.createElement('div');container.className='article-media';for(const item of attachments)appendMedia(container,item);row.querySelector('.posttext').after(container);}
  const state=actionState(index),like=row.querySelector('.like-post'),repost=row.querySelector('.repost-post'),bookmark=row.querySelector('.bookmark-post'),reply=row.querySelector('.reply-post');
  const indicator=document.createElement('div');indicator.className='repost-label';indicator.textContent='↻ Reposted by you · local';indicator.hidden=!state.reposted;row.querySelector('.author').before(indicator);
  function sync(){like.setAttribute('aria-pressed',String(!!state.liked));like.setAttribute('aria-label',state.liked?'Unlike tweet':'Like tweet');like.querySelector('.action-count').textContent=state.liked?'1':'';repost.setAttribute('aria-pressed',String(!!state.reposted));repost.setAttribute('aria-label',state.reposted?'Undo local repost':'Repost tweet locally');repost.querySelector('.action-count').textContent=state.reposted?'1':'';bookmark.setAttribute('aria-pressed',String(!!state.bookmarked));bookmark.setAttribute('aria-label',state.bookmarked?'Remove tweet bookmark':'Bookmark tweet');reply.querySelector('.action-count').textContent=state.replies.length||'';indicator.hidden=!state.reposted;}
  like.onclick=()=>{state.liked=!state.liked;sync();storeInteractions();};
  repost.onclick=()=>{state.reposted=!state.reposted;sync();storeInteractions();toast(state.reposted?'Reposted in this thread · only you can see this':'Local repost removed');};
  bookmark.onclick=()=>{state.bookmarked=!state.bookmarked;sync();storeInteractions(state.bookmarked);toast(state.bookmarked?'Tweet bookmarked · thread saved on this device':'Tweet bookmark removed');};
  reply.onclick=()=>showReplies(index,sync);sync();
}
function appendMedia(container,item) {
  const url=remoteUrl(item.url);if(!url)return;
  const figure=document.createElement('figure');figure.className='article-attachment';
  function fallback(){figure.replaceChildren();const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open media at the source ↗';link.className='media-fallback';figure.append(link);}
  if(item.type==='image'){
    const button=document.createElement('button');button.className='media-image-button';button.setAttribute('aria-label','Enlarge image: '+(item.alt||'Article image'));const image=document.createElement('img');image.src=mediaUrl(url);image.alt=item.alt||'Image from the article';image.loading='lazy';image.referrerPolicy='no-referrer';image.onerror=fallback;button.append(image);button.onclick=()=>{modal(item.caption?'Image from the article':'Article image');const large=document.createElement('img');large.className='lightbox-image';large.src=mediaUrl(url);large.alt=item.alt||'Article image';$('modalBody').append(large);if(item.caption){const p=document.createElement('p');p.textContent=item.caption;$('modalBody').append(p);}const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open original image ↗';$('modalBody').append(link);};figure.append(button);
  }else if(item.type==='video'||item.type==='audio'){
    const player=document.createElement(item.type);player.src=url;player.controls=true;player.preload='metadata';player.setAttribute('aria-label',item.caption||'Media from the article');if(item.poster&&item.type==='video')player.poster=mediaUrl(item.poster);player.onerror=fallback;figure.append(player);
  }else if(item.type==='embed'&&/^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}$/.test(url)){
    const frame=document.createElement('iframe');frame.src=url;frame.title=item.title||'Video from the article';frame.loading='lazy';frame.allow='encrypted-media; fullscreen; picture-in-picture';frame.referrerPolicy='strict-origin-when-cross-origin';frame.allowFullscreen=true;figure.append(frame);
  }else fallback();
  if(item.caption){const caption=document.createElement('figcaption');caption.textContent=item.caption;figure.append(caption);}
  container.append(figure);
}
function showReplies(index,onChange) {
  modal('Your replies to tweet '+(index+1));
  const note=document.createElement('p');note.className='dialog-description';note.textContent='A space for your thoughts. Replies are saved on this device and are not published to Twitter/X.';
  const quote=document.createElement('blockquote');quote.className='reply-quote';quote.textContent=posts[index];
  const list=document.createElement('div');list.className='local-replies';
  const form=document.createElement('form');form.className='reply-form';const label=document.createElement('label');label.htmlFor='replyText';label.textContent='Add a reply';const input=document.createElement('textarea');input.id='replyText';input.maxLength=2000;input.placeholder='What does this idea make you think of?';input.required=true;const send=document.createElement('button');send.className='copy-primary';send.textContent='Add reply';send.type='submit';send.disabled=true;input.oninput=()=>send.disabled=!input.value.trim();
  function draw(){list.replaceChildren();for(const reply of actionState(index).replies){if(typeof reply.text!=='string')continue;const article=document.createElement('article'),name=document.createElement('strong'),text=document.createElement('p');name.textContent='You';text.textContent=reply.text;article.append(name,text);list.append(article);}}
  form.append(label,input,send);form.onsubmit=event=>{event.preventDefault();const text=input.value.trim();if(!text)return;actionState(index).replies.push({text,date:new Date().toISOString()});storeInteractions(true);draw();onChange();input.value='';send.disabled=true;toast('Reply saved on this device');};
  $('modalBody').append(note,quote,list,form);draw();input.focus();
}

function textMedia(text) { const media=[];for(const m of text.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)){if(media.length>=16)break;const url=remoteUrl(m[2]);if(url&&!media.some(item=>item.url===url))media.push({type:'image',url,alt:m[1]||'Image from the text source',caption:'',position:m.index/Math.max(text.length,1)});}return media; }

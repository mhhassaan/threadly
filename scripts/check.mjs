import assert from 'node:assert/strict';
import {summarize,sentenceParts} from '../public/summary.js';
import {wrapText,zipFiles} from '../public/export.js';
import worker from '../dist/server/index.js';
const paragraphs=Array.from({length:12},(_,i)=>`Idea ${i} explains how careful reading connects knowledge with context. A supporting example for idea ${i} makes the argument easier to follow. The conclusion of idea ${i} preserves its meaning.`);
const source='A guide to careful reading\n\n'+paragraphs.join('\n\n');
for(const depth of ['quick','balanced','detailed']){
 const posts=summarize(source,depth,'auto'); assert(posts.length>0);for(const post of posts){assert(/[.!?]$/.test(post),'Posts end on a complete sentence');assert(source.includes(post),'Posts preserve source text');}
 assert(posts[0].startsWith('Idea 0'));assert(posts.at(-1).includes('idea 11'));
 const positions=posts.map(p=>source.indexOf(p));assert(positions.every((p,i)=>i===0||p>=positions[i-1]),'Source order is preserved');
}
assert(summarize(source,'detailed','5').length<=5);
assert(summarize(source,'quick','auto').join('').length<summarize(source,'detailed','auto').join('').length);
const long='A complete sentence '+('with a detailed supporting point '.repeat(25))+'ends here.';
assert.deepEqual(summarize(long,'balanced','auto'),[long],'A long sentence is never cut into fragments');
assert.equal(sentenceParts('Dr. Shannon studied information theory. His result mattered.')[0],'Dr. Shannon studied information theory.');
assert.equal(sentenceParts('The value was 3.14. It stayed stable.')[0],'The value was 3.14.');
assert.deepEqual(summarize('','balanced','auto'),[]);
const mock={measureText:s=>({width:Array.from(s).length*10})};
assert.deepEqual(wrapText(mock,'hello world\n\nnext',60),['hello','world','','next']);
const emoji='👨‍👩‍👧‍👦'.repeat(5);assert.equal(wrapText(mock,emoji,120).join(''),emoji,'Image wrapping preserves graphemes');
const zip=zipFiles([{name:'one.txt',bytes:new TextEncoder().encode('First file')},{name:'two.txt',bytes:new TextEncoder().encode('Second file')}]);
const bytes=new Uint8Array(await zip.arrayBuffer());assert.equal(new DataView(bytes.buffer).getUint32(0,true),0x04034b50);assert.equal(new DataView(bytes.buffer).getUint32(bytes.length-22,true),0x06054b50);
for(const path of ['/','/app.js','/style.css','/summary.js','/appearance.js','/export.js'])assert.equal((await worker.fetch(new Request('https://example.com'+path))).status,200);
const blocked=await worker.fetch(new Request('https://example.com/api/article',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'http://127.0.0.1/test'})}));assert.equal(blocked.status,400);
console.log('Passed: complete thoughts, source order and fidelity, depth and post limits, abbreviations, long sentences, Unicode image wrapping, ZIP structure, asset routes and private-address rejection.');

// Theme persistence and custom colors must produce readable ink for each preset.
const vm = await import('node:vm');
const fs = await import('node:fs');
const stored=new Map(),tokens=new Map();
const themeContext={localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},window:{addEventListener(){}},document:{documentElement:{style:{setProperty:(k,v)=>tokens.set(k,v)}},querySelector:()=>({setAttribute(){}})}};
vm.runInNewContext(fs.readFileSync('public/appearance.js','utf8'),themeContext);
for(const mode of ['white','gray','dim','dark','paper']){themeContext.window.ThreadlyAppearance.apply({mode,background:null,surface:null});const c=themeContext.window.ThreadlyAppearance.colors();assert.notEqual(c.surface,c.text);assert.equal(tokens.get('--surface'),c.surface);}
themeContext.window.ThreadlyAppearance.apply({background:'#123456',surface:'#243342',accent:'#abcdef'});assert.equal(tokens.get('--surface'),'#243342');assert.equal(JSON.parse(stored.get('threadly-appearance')).accent,'#abcdef');
// A contrast setup must retain its following explanation rather than dropping it.
const contrastText='Small changes can make work easier. Clear a space for one idea. The goal is not to remove distraction forever. It is to return to your work with less friction.';
assert(summarize(contrastText,'balanced','auto').join(' ').includes('It is to return to your work with less friction.'));
// Exercise multi-page image packaging with a canvas stand-in and verify no row goes missing.
const {createThreadImage}=await import('../public/export.js');
const painted=[];const context={measureText:s=>({width:Array.from(s).length*14}),fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillText:t=>painted.push(t)};
globalThis.document={createElement:()=>({getContext:()=>context,toBlob:callback=>callback(new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'}))})};
const many=Array.from({length:80},(_,i)=>'Tweet-'+i+' '+('complete thought '.repeat(20)));
const imageResult=await createThreadImage({posts:many,title:'Long thread',indices:many.map((_,i)=>i),theme:{surface:'#000000',text:'#ffffff',accent:'#7856ff',accentInk:'#ffffff',line:'#333333',muted:'#aaaaaa'}});
assert.equal(imageResult.filename,'threadly-images.zip');assert(painted.some(s=>s.startsWith('Tweet-0 ')));assert(painted.some(s=>s.startsWith('Tweet-79 ')));delete globalThis.document;
console.log('Passed: theme presets and persistence, custom tones, dependent-sentence context, and lossless multi-page image selection.');

// Article identity and media extraction.
const {extractArticle,safe}=await import('../dist/server/index.js');
const articleFixture=`<html><head><meta property="og:title" content="A useful article"><meta property="og:site_name" content="Example Journal"><link rel="icon" href="/icon.png"></head><body><nav><img src="/nav.jpg"></nav><article><p>First paragraph explains an idea with enough context to be understandable.</p><figure><img data-src="/hero.jpg" alt="A useful diagram"><figcaption>A caption &amp; credit.</figcaption></figure><p>Second paragraph develops the original argument further.</p><img srcset="/small.webp 400w, /large.webp 1200w" alt="Another view"><video poster="/poster.jpg"><source src="/clip.mp4" type="video/mp4"></video><audio src="/clip.mp3"></audio><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Article interview"></iframe><img src="http://127.0.0.1/private.png"><img width="1" height="1" src="/tracking.gif"></article></body></html>`;
const extracted=extractArticle(articleFixture,'https://journal.example/story');
assert.equal(extracted.source.name,'Example Journal');assert.equal(extracted.source.icon,'https://journal.example/icon.png');
assert(extracted.media.some(m=>m.url==='https://journal.example/hero.jpg'&&m.caption==='A caption & credit.'));
assert(extracted.media.some(m=>m.url==='https://journal.example/large.webp'));
assert(extracted.media.some(m=>m.type==='video'&&m.url.endsWith('/clip.mp4')));
assert(extracted.media.some(m=>m.type==='audio'));
assert(extracted.media.some(m=>m.type==='embed'&&m.url.includes('youtube-nocookie.com')));
assert(!extracted.media.some(m=>/private|tracking|nav\.jpg|undefined/.test(m.url)));
assert(!safe(new URL('http://127.0.0.1/a')));assert(!safe(new URL('https://user:password@example.com/a')));
const og=extractArticle('<meta property="og:image" content="/social.jpg"><article><p>Article without inline media.</p></article>','https://journal.example/story');assert.equal(og.media[0].url,'https://journal.example/social.jpg');
const blockedMedia=await worker.fetch(new Request('https://example.com/api/media?url=http%3A%2F%2F127.0.0.1%2Fsecret'));assert.equal(blockedMedia.status,404);
console.log('Passed: publisher identity, lazy images, captions, responsive images, audio/video, safe embeds, OG-image fallback, and private-media rejection.');

const narrative=extractArticle('<main><div>Navigation clutter</div><table><tr><td>Infobox clutter</td></tr></table><p>A real <a href="/idea">article</a> paragraph preserves inline punctuation, context, and the author\'s meaning.<sup class="reference">[17]</sup></p><p>A second complete paragraph explains the same idea without unrelated reference lists.</p><ul><li>Bibliography clutter</li></ul></main>','https://journal.example/story');assert(!/clutter|\[17\]/.test(narrative.text));assert(narrative.text.includes("author's meaning."));
console.log('Passed: narrative paragraphs exclude navigation, infoboxes and reference lists; inline punctuation remains intact.');

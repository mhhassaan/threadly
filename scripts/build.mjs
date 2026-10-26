import { mkdir,readFile,writeFile,copyFile,readdir } from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
let src=await readFile('worker/index.js','utf8');
for(const [key,file] of [['HTML','index.html'],['CSS','style.css'],['JS','app.js'],['SUMMARY','summary.js'],['APPEARANCE','appearance.js'],['EXPORT','export.js']]) {
  const contents=JSON.stringify(await readFile('public/'+file,'utf8'));src=src.replace('/*'+key+'*/',()=>contents);
}
const fonts={};
for(const file of await readdir('public/fonts')){if(!/\.(?:ttf|woff|txt|md)$/i.test(file))continue;const data=await readFile('public/fonts/'+file);fonts['/fonts/'+file]={type:file.endsWith('.ttf')?'font/ttf':file.endsWith('.woff')?'font/woff':'text/plain;charset=utf-8',data:data.toString('base64')};}
src=src.replace('/*FONTS*/',()=>JSON.stringify(fonts));
const brand={};
for(const file of await readdir('public/brand')){if(!/\.(?:png|svg|md|txt)$/i.test(file))continue;const data=await readFile('public/brand/'+file);brand['/brand/'+file]={type:file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/plain;charset=utf-8',data:data.toString('base64')};}
src=src.replace('/*BRAND*/',()=>JSON.stringify(brand));
await writeFile('dist/server/index.js',src);
// Hosting identity stays local; a source checkout can build without a deployment.
try { await copyFile('.openai/hosting.json','dist/.openai/hosting.json'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('Built Threadly');


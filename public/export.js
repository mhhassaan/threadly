// Native canvas export keeps text selectable in the app and produces self-contained PNGs.
export function wrapText(ctx, text, width) {
  const lines=[];
  for(const paragraph of String(text).split('\n')) {
    if(!paragraph){lines.push('');continue;}
    let line='';
    for(const word of paragraph.split(/\s+/)) {
      const trial=line?line+' '+word:word;
      if(ctx.measureText(trial).width<=width){line=trial;continue;}
      if(line){lines.push(line);line='';}
      if(ctx.measureText(word).width<=width){line=word;continue;}
      // Split only for drawing, never omit characters in long URLs or unbroken text.
      for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(word)) {
        if(line&&ctx.measureText(line+segment).width>width){lines.push(line);line='';}line+=segment;
      }
    }
    if(line)lines.push(line);
  }
  return lines;
}
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
// Uncompressed ZIP: a single browser download when a large thread needs several PNG pages.
export function zipFiles(files) {
  let offset=0;const chunks=[],directory=[];const enc=new TextEncoder();
  const header=(n)=>{const b=new Uint8Array(n);return [b,new DataView(b.buffer)];};
  for(const file of files){const name=enc.encode(file.name),data=file.bytes,crc=crc32(data);let [local,v]=header(30);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);chunks.push(local,name,data);let [central,c]=header(46);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);directory.push(central,name);offset+=local.length+name.length+data.length;}
  const directorySize=directory.reduce((n,b)=>n+b.length,0);let [end,v]=header(22);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,directorySize,true);v.setUint32(16,offset,true);return new Blob([...chunks,...directory,end],{type:'application/zip'});
}
export async function createThreadImage({posts,title,sourceUrl='',source=null,media=[],indices,theme}) {
  if(!indices?.length)throw Error('Select at least one tweet to export.');
  if(document.fonts?.load)await Promise.all([document.fonts.load('400 40px "Jersey 25"'),document.fonts.load('400 28px Chirp'),document.fonts.load('700 23px Chirp')]);
  const brandMark=await loadBrandMark();
  const width=1100,padding=52,textX=150,textWidth=width-textX-padding;
  const relevant=media.filter(item=>indices.includes(item.postIndex));
  const urls=[...new Set([source?.icon,...relevant.flatMap(item=>item.type==='image'?[item.url]:item.poster?[item.poster]:[])].filter(Boolean))];
  const images=new Map();await Promise.all(urls.map(async url=>{const image=await loadRaster(url);if(image)images.set(url,image);}));
  const warnings=relevant.filter(item=>item.type==='image'&&!images.has(item.url)).length;
  const probe=document.createElement('canvas');const measure=probe.getContext('2d');if(!measure)throw Error('Image export is unavailable in this browser.');
  measure.font='40px "Jersey 25"';const titleLines=wrapText(measure,title||'Your reading thread',width-padding*2);
  const headerHeight=115+titleLines.length*48;
  measure.font='28px Chirp';
  const rows=indices.map(index=>({index,lines:wrapText(measure,posts[index],textWidth)})).map(row=>({...row,height:Math.max(180,125+row.lines.length*42)}));
  // Keep canvas size below common browser limits. Very long single tweets can continue on another page.
  const pieces=[];const maxLines=160;
  for(const row of rows)for(let i=0;i<Math.max(1,row.lines.length);i+=maxLines){const lines=row.lines.slice(i,i+maxLines);const allAttachments=i===0?relevant.filter(item=>item.postIndex===row.index):[];
    const attachments=allAttachments.slice(0,3);
    const attachmentsHeight=attachments.reduce((sum,item)=>{const image=images.get(item.type==='image'?item.url:item.poster);return sum+(image?Math.min(480,textWidth*image.height/image.width)+25:55)+(item.caption?60:0);},0);
    pieces.push({...row,lines,attachments,continued:i>0,height:Math.max(180,125+lines.length*42+attachmentsHeight)});
    for(let j=3;j<allAttachments.length;j+=3){const extra=allAttachments.slice(j,j+3),h=extra.reduce((sum,item)=>{const image=images.get(item.type==='image'?item.url:item.poster);return sum+(image?Math.min(480,textWidth*image.height/image.width)+25:55)+(item.caption?60:0);},0);pieces.push({...row,lines:[],attachments:extra,continued:true,height:h+125});}}
  const pages=[];let current=[],height=headerHeight;
  for(const row of pieces){if(current.length&&height+row.height+115>10000){pages.push(current);current=[];height=headerHeight;}current.push(row);height+=row.height;}
  if(current.length)pages.push(current);
  const files=[];
  for(let page=0;page<pages.length;page++){
    const pageRows=pages[page],canvas=document.createElement('canvas');canvas.width=width;canvas.height=headerHeight+pageRows.reduce((n,row)=>n+row.height,0)+115;
    const ctx=canvas.getContext('2d');ctx.fillStyle=theme.surface;ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.textBaseline='top';ctx.fillStyle=theme.accent;ctx.font='24px "Jersey 25"';if(brandMark){ctx.drawImage(brandMark,padding,26,32,32);ctx.fillText('threadly',padding+40,31);}else ctx.fillText('THREADLY',padding,35);
    ctx.fillStyle=theme.text;ctx.font='40px "Jersey 25"';titleLines.forEach((line,i)=>ctx.fillText(line,padding,78+i*48));
    ctx.fillStyle=theme.muted;ctx.font='19px Chirp';ctx.fillText(indices.length+' tweet'+(indices.length===1?'':'s')+(pages.length>1?' · Part '+(page+1)+'/'+pages.length:''),padding,headerHeight-33);
    let y=headerHeight;
    pageRows.forEach((row,rowIndex)=>{
      ctx.strokeStyle=theme.line;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padding,y);ctx.lineTo(width-padding,y);ctx.stroke();
      if(rowIndex<pageRows.length-1){ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(88,y+91);ctx.lineTo(88,y+row.height);ctx.stroke();}
      ctx.fillStyle=theme.accent;ctx.beginPath();ctx.arc(88,y+55,32,0,Math.PI*2);ctx.fill();const icon=images.get(source?.icon);
      if(icon){ctx.save();ctx.beginPath();ctx.arc(88,y+55,32,0,Math.PI*2);ctx.clip();ctx.drawImage(icon,56,y+23,64,64);ctx.restore();}
      else{ctx.fillStyle=theme.accentInk;ctx.beginPath();ctx.arc(88,y+45,9,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(88,y+74,17,Math.PI,0);ctx.fill();}
      ctx.fillStyle=theme.text;ctx.font='bold 23px Chirp';const displayName=source?.name||'You',name=displayName.length>26?displayName.slice(0,25)+'…':displayName;ctx.fillText(name,textX,y+28);const nameWidth=ctx.measureText(name).width;ctx.fillStyle=theme.muted;ctx.font='21px Chirp';const handle=source?.handle?'@'+source.handle:'@you';if(nameWidth<430)ctx.fillText(handle.slice(0,36),textX+nameWidth+12,y+30);
      ctx.font='18px Chirp';const label=(row.index+1)+'/'+posts.length+(row.continued?' · continued':'');ctx.fillText(label,width-padding-ctx.measureText(label).width,y+31);
      ctx.fillStyle=theme.text;ctx.font='28px Chirp';row.lines.forEach((line,i)=>ctx.fillText(line,textX,y+74+i*42));
      let mediaY=y+86+row.lines.length*42;
      for(const item of row.attachments){const image=images.get(item.type==='image'?item.url:item.poster);
        if(image){const h=Math.min(480,textWidth*image.height/image.width),w=h*image.width/image.height;ctx.drawImage(image,textX+(textWidth-w)/2,mediaY,w,h);mediaY+=h+25;}
        else{ctx.fillStyle=theme.muted;ctx.font='20px Chirp';ctx.fillText(item.type==='image'?'Image unavailable — see the original source.':item.type==='audio'?'Audio — listen at the original source.':'Video — watch at the original source.',textX,mediaY);mediaY+=55;}
        if(item.caption){ctx.fillStyle=theme.muted;ctx.font='19px Chirp';wrapText(ctx,item.caption,textWidth).slice(0,2).forEach((line,i)=>ctx.fillText(line,textX,mediaY+i*25));mediaY+=60;}
      }y+=row.height;
    });
    ctx.strokeStyle=theme.line;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padding,y);ctx.lineTo(width-padding,y);ctx.stroke();
    ctx.fillStyle=theme.muted;ctx.font='18px Chirp';const foot=sourceUrl?'Source: '+sourceUrl:'A little less noise. A lot more clarity.';const footerLines=wrapText(ctx,foot,width-padding*2);footerLines.slice(0,2).forEach((line,i)=>ctx.fillText(line,padding,y+25+i*25));
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('Could not create the image. Try fewer tweets.');
    files.push({name:'threadly-'+(pages.length>1?'part-'+(page+1):indices.length===1?'tweet-'+(indices[0]+1):'thread')+'.png',bytes:new Uint8Array(await blob.arrayBuffer())});
    // Release the large pixel buffer before rendering the next page.
    canvas.width=1;canvas.height=1;
  }
  if(files.length===1)return {blob:new Blob([files[0].bytes],{type:'image/png'}),filename:files[0].name,warnings};
  return {blob:zipFiles(files),filename:'threadly-images.zip',warnings};
}

function loadRaster(url) {
  return new Promise(resolve=>{if(typeof Image==='undefined'){resolve(null);return;}const image=new Image();const timer=setTimeout(()=>{image.onload=null;image.onerror=null;resolve(null);},8000);image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);resolve(null);};image.src='/api/media?url='+encodeURIComponent(url);});
}

function loadBrandMark(){return new Promise(resolve=>{if(typeof Image==='undefined'){resolve(null);return;}const image=new Image();const timer=setTimeout(()=>{image.onload=null;image.onerror=null;resolve(null);},3000);image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);resolve(null);};image.src='/brand/threadly-mark.svg';});}

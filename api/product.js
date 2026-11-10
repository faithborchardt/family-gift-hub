
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const allowed = ['amazon.com','amazon.co.uk','amzn.to','target.com','walmart.com','etsy.com','tiktok.com','vm.tiktok.com','vt.tiktok.com'];
const matches = host => allowed.some(d => host === d || host.endsWith('.' + d));
const privateIP = ip => {
  if (ip.includes(':')) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('::ffff:');
  const a=ip.split('.').map(Number);
  return a[0]===0 || a[0]===10 || a[0]===127 || a[0]>=224 || (a[0]===169&&a[1]===254) || (a[0]===172&&a[1]>=16&&a[1]<=31) || (a[0]===192&&a[1]===168) || (a[0]===100&&a[1]>=64&&a[1]<=127) || (a[0]===192&&a[1]===0&&a[2]===0);
};
async function safeUrl(value) {
  const url=new URL(value);
  if (url.protocol!=='https:' || url.username || url.password || url.port || !matches(url.hostname.toLowerCase()) || isIP(url.hostname)) throw new Error('Unsupported shopping link');
  const addresses=await lookup(url.hostname,{all:true,verbatim:true});
  if (!addresses.length || addresses.some(a=>privateIP(a.address))) throw new Error('Unsafe destination');
  return url;
}
function decode(s='') {return s.replace(/&quot;|&#34;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).trim();}
function tags(html) {
 const result={};
 for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
   const tag=m[0],attrs={};
   for(const a of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()]=decode(a[2]??a[3]??a[4]);
   const key=(attrs.property||attrs.name||'').toLowerCase();
   if(key && attrs.content && !result[key]) result[key]=attrs.content;
 }
 return result;
}
function findProduct(node, depth=0) {
 if(depth>7 || !node || typeof node!=='object') return null;
 if(Array.isArray(node)) {for(const x of node){const p=findProduct(x,depth+1);if(p)return p;}return null;}
 const type=node['@type'];
 if(type==='Product' || (Array.isArray(type)&&type.includes('Product'))) return node;
 for(const key of ['@graph','mainEntity','itemListElement']) {const p=findProduct(node[key],depth+1);if(p)return p;}
 return null;
}
function productJson(html) {
 for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
  try {const p=findProduct(JSON.parse(m[1]));if(p)return p;}catch{}
 }
 return null;
}
function firstImage(v) {if(typeof v==='string')return v;if(Array.isArray(v))return firstImage(v[0]);if(v&&typeof v==='object')return v.url||v.contentUrl||'';return '';}
function cleanPrice(v) {if(v===undefined||v===null||v==='')return null;const n=Number(String(v).replace(/[$,\s]/g,''));return Number.isFinite(n)&&n>=0&&n<1000000? n:null;}
export async function GET(request) {
 try {
  const incoming=new URL(request.url).searchParams.get('url');
  if(!incoming || incoming.length>3000) return Response.json({error:'Please provide a product link.'},{status:400});
  let target=await safeUrl(incoming), response;
  for(let i=0;i<5;i++) {
   response=await fetch(target,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0 (compatible; FamilyGiftHub/1.0)','accept':'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(7000)});
   if([301,302,303,307,308].includes(response.status)) {
    const next=response.headers.get('location');if(!next)break;
    target=await safeUrl(new URL(next,target).href);continue;
   }
   break;
  }
  if(!response?.ok || !(response.headers.get('content-type')||'').includes('text/html')) return Response.json({retailer:target.hostname.replace(/^www\./,''),message:'Product details unavailable. You can enter them manually.'});
  const size=Number(response.headers.get('content-length')||0);
  if(size>1500000) return Response.json({message:'Product page is too large to import automatically.'});
  const reader=response.body?.getReader();let chunks=[],bytes=0;
  if(reader) {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1500000){await reader.cancel();break;}chunks.push(value);}}
  const html=new TextDecoder().decode(Buffer.concat(chunks.map(x=>Buffer.from(x))));
  const meta=tags(html), p=productJson(html);
  const offers=Array.isArray(p?.offers)?p.offers[0]:p?.offers;

const price = cleanPrice(
  offers?.price ??
  offers?.lowPrice ??
  meta['product:price:amount'] ??
  meta['og:price:amount'] ??
  meta['twitter:data1'] ??
  html.match(/"current_retail"\s*:\s*([0-9.]+)/i)?.[1] ??
  html.match(/"formatted_current_price"\s*:\s*"\$?([0-9,.]+)"/i)?.[1] ??
  html.match(/"price"\s*:\s*\{\s*"current_retail"\s*:\s*([0-9.]+)/i)?.[1]
);

  let name=String(p?.name || meta['og:title'] || meta['twitter:title'] || '').trim();
  if(!name){const t=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);name=t?decode(t[1]):'';}
  let image=firstImage(p?.image)||meta['og:image']||meta['twitter:image']||'';
  try {image=image?new URL(image,target).href:'';if(image&&!image.startsWith('https://'))image='';}catch{image='';}
  const retailer=target.hostname.replace(/^www\./,'');
  return Response.json({name:name.slice(0,200),price,image,retailer,link:incoming},{headers:{'cache-control':'private, max-age=120'}});
 } catch(e) {return Response.json({message:'Automatic details were unavailable. You can enter them manually.'},{status:200});}
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({error:'Method not allowed'});
  }
  const requestUrl = new URL(req.url || '/', 'https://family-gift-hub-beta.vercel.app');
  const result = await GET(new Request(requestUrl));
  res.status(result.status);
  res.setHeader('Cache-Control', 'private, max-age=120');
  return res.send(await result.text());
}

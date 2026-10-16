// Production adapter from fr0stb1rd/ema-lightning-web, Apache-2.0.
// Pinned source 174f29442e67d73ab15ab9e34412b64affd579cb; frontend/math unchanged.
import * as ort from "onnxruntime-web";
import { configureOrt } from './ortConfig';
import type { SynthesisResult } from '../core/types';
export const EMA_SAMPLE_RATE = 48000;
export interface EMAVocabulary { vocab:string[]; stoi:Record<string,number>; times:number[]; latent_dim:number }
export interface EMAAssets { vocabulary:EMAVocabulary; models:ArrayBuffer[] }
export async function createEMA(assets:EMAAssets){
configureOrt();
const v=assets.vocabulary;const VOCAB=v.vocab,STOI=v.stoi,TIMES=v.times,LATENT=v.latent_dim;
const RATE=48000,FPS=25,FIRST_WINDOW=25,WINDOW=100,CONTEXT=8,MAX_WORD_FRAMES=250,MAX_FRAMES=3000,MAX_LETTERS=250;
const owned=new Set<ort.Tensor>();
const own=(t:ort.Tensor)=>{owned.add(t);return t;};
const cleanup=()=>{for(const t of owned)t.dispose();owned.clear();};
// Let real pause/seek/navigation messages run between synchronous WASM kernels.
// MessageChannel avoids nested background timer clamping; no model math changes.
const yieldControl=()=>new Promise<void>(resolve=>{
 const channel=new MessageChannel();
 channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};
 channel.port2.postMessage(null);
});
const Big=(arr:number[],dims:number[])=>own(new ort.Tensor("int64",BigInt64Array.from(arr.map(BigInt)),dims));
const F32=(arr:number[]|Float32Array,dims:number[])=>own(new ort.Tensor("float32",Float32Array.from(arr),dims));
const Bool=(arr:number[],dims:number[])=>own(new ort.Tensor("bool",Uint8Array.from(arr.map(Number)),dims));
const opts:ort.InferenceSession.SessionOptions={executionProviders:["wasm"],graphOptimizationLevel:"all",extra:{optimization:{disable_specified_optimizers:"SkipLayerNormFusion BiasSkipLayerNormFusion"}}};
const created=await Promise.allSettled(assets.models.map(buffer=>ort.InferenceSession.create(buffer,opts)));
if(created.some(s=>s.status==='rejected')) {
 await Promise.all(created.map(s=>s.status==='fulfilled'?s.value.release():Promise.resolve()));
 throw (created.find(s=>s.status==='rejected') as PromiseRejectedResult).reason;
}
const [sessText,sessSound,sessDec]=created.map(s=>(s as PromiseFulfilledResult<ort.InferenceSession>).value);

function mulberry32(seed:number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rows:number, cols:number, rand:()=>number) {
  const o = new Float32Array(rows * cols);
  for (let i = 0; i < o.length; i += 2) {
    const u1 = Math.max(rand(), 1e-9), u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1)), t = 2 * Math.PI * u2;
    o[i] = r * Math.cos(t); if (i + 1 < o.length) o[i + 1] = r * Math.sin(t);
  }
  return o;
}
function finish(p:string) {
  const s = p.replace(/["')]+$/, "");
  return [".", "!", "?"].includes(s.slice(-1)) ? p : p.replace(/[,;:\- ]+$/, "") + ".";
}
function chunk(text:string, speed:number) {
  const limit = Math.min(MAX_LETTERS, Math.round(18 * 10 * speed));
  const cuts: [RegExp,number][] = [[/[.!?]+["']*(?= )/g, 0.25], [/[,;:](?= )/g, 0.12], [/\S(?= )/g, 0.12]];
  const pieces: [string,number][] = [];
  let rest = text.trim();
  while (rest) {
    let cut = rest.length, pause = 0;
    if (rest.length > limit) {
      cut = limit;
      for (const [re, gap] of cuts) {
        const ends = []; const rx = new RegExp(re.source, "g");
        let m; while ((m = rx.exec(rest)) && m.index <= limit) ends.push(m.index + m[0].length);
        if (ends.length) { cut = ends[ends.length - 1]; pause = gap; break; }
      }
    }
    const piece = rest.slice(0, cut).trim(); rest = rest.slice(cut).trim();
    if (/\p{L}/u.test(piece)) pieces.push([finish(piece), pause]);
  }
  if (pieces.length) pieces[pieces.length - 1][1] = 0;
  return pieces;
}
function alphabet(text:string) { // SADELESTIRILMIS: normalizer-tr yok, sayilari yaziyle yazin
  // Orijinal frontend.py ile ayni: Turkce harfler oldugu gibi kalir (NFKD'ye sokulmaz),
  // diger harflerin aksanlari soyulur, vocab'da olmayan her sey bosluk olur.
  const TURKISH = new Set([..."çğıöşü"]);
  const typo:Record<string,string> = { "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "..." };
  text = text.replace(/[’‘“”–—…]/g, (c) => typo[c] || c).toLocaleLowerCase("tr");
  const vs = new Set(VOCAB);
  let out = "";
  for (const ch of text) {
    if (TURKISH.has(ch)) { out += vs.has(ch) ? ch : " "; continue; }
    const base = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    out += (base && [...base].every((c) => vs.has(c))) ? base : " ";
  }
  return out.replace(/\s+/g, " ").trim();
}
function piece(text:string) {
  const ids = [...text].map((c) => STOI[c] ?? 1);
  const starts:number[] = [];
  [...text].forEach((c, i) => { if (c !== " " && (i === 0 || text[i - 1] === " ")) starts.push(i); });
  if (!starts.length) starts.push(0);
  const bounds = [0, ...starts.slice(1), text.length];
  const cw:number[] = [], wstart:number[] = [];
  for (let w = 0; w < bounds.length - 1; w++)
    for (let i = bounds[w]; i < bounds[w + 1]; i++) { cw.push(w); wstart.push(bounds[w]); }
  return { text, ids, cw, wstart };
}
function plan(p:ReturnType<typeof piece>, dur:number[]) {
  const nw = p.cw[p.cw.length - 1] + 1;
  const per = new Array(nw).fill(0);
  p.cw.forEach((w, i) => per[w] += dur[i]);
  const n = per.map((x) => Math.min(MAX_WORD_FRAMES, Math.max(1, Math.round(x))));
  const frames = Math.min(n.reduce((a, b) => a + b, 0), MAX_FRAMES);
  const cum = []; let s = 0; for (const x of n) { cum.push(s); s += x; }
  const fw:number[] = [], fp:number[] = [];
  let k = 0;
  for (let w = 0; w < nw && k < frames; w++)
    for (let j = 0; j < n[w] && k < frames; j++, k++) { fw.push(w); fp.push((k - cum[w]) / n[w]); }
  return { fw, fp, frames };
}
function windows(frames:number, first = WINDOW) {
  const spans:[number,number][] = []; let s = 0;
  while (s < frames) { const e = Math.min(frames, s + (s === 0 ? first : WINDOW)); spans.push([s, e]); s = e; }
  return spans;
}
const concat = (parts:Float32Array[]) => {
  const out = new Float32Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0; for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
};

async function* synthPieces(text:string, speed:number, seed:number, stats:Record<string,number>, signal?:AbortSignal) {
  const spoken = alphabet(text);
  let seedI = 0;
  const tick = (key:string, t0:number) => { if (stats) stats[key] = (stats[key] || 0) + performance.now() - t0; };
  for (const [part, pause] of chunk(spoken, speed)) {
    await yieldControl();signal?.throwIfAborted();
    const p = piece(part);
    const L = p.ids.length;
    let t0 = performance.now();
    const textFeeds={ ids: Big(p.ids,[1,L]),mask:Bool(new Array(L).fill(1),[1,L]) };
    const t=await sessText.run(textFeeds);Object.values(t).forEach(own);await yieldControl();signal?.throwIfAborted();
    const d = t.h.dims[2];
    const h = Array.from(await t.h.getData() as Float32Array), dur = Array.from(await t.dur.getData() as Float32Array).map((x) => x / speed);
    tick("text", t0);
    const { fw, fp, frames } = plan(p, dur);
    const rand = mulberry32((seed * 1000003 + seedI++) >>> 0);
    const noise:number[] = [];
    for (let k = 0; k < TIMES.length; k++) noise.push(...randn(frames, LATENT, rand));
    t0 = performance.now();
    const soundFeeds = {
      h: F32(h, [1, L, d]), dur: F32(dur, [1, L]),
      mask: Bool(new Array(L).fill(1), [1, L]),
      cw: Big(p.cw, [1, L]), wstart: Big(p.wstart, [1, L]),
      fw: Big(fw, [1, frames]), fp: F32(fp, [1, frames]),
      fmask: Bool(new Array(frames).fill(1), [1, frames]),
      noise: F32(noise, [1, TIMES.length, frames, LATENT]),
    };
    signal?.throwIfAborted();
    const lat=await sessSound.run(soundFeeds);Object.values(lat).forEach(own);await yieldControl();signal?.throwIfAborted();
    const latents = Array.from(await lat.latents.getData() as Float32Array);
    tick("sound", t0);
    const waves:Float32Array[] = [];
    for (const [ws, we] of windows(frames, FIRST_WINDOW)) {
      const a = Math.max(0, ws - CONTEXT), b = Math.min(frames, we + CONTEXT);
      const n = b - a, z = new Float32Array(LATENT * n);
      for (let f = 0; f < n; f++)
        for (let c = 0; c < LATENT; c++) z[c * n + f] = latents[(a + f) * LATENT + c];
      t0 = performance.now();
      signal?.throwIfAborted();
      const decoderInput=own(new ort.Tensor("float32",z,[1,LATENT,n]));
      const dec=await sessDec.run({z:decoderInput});Object.values(dec).forEach(own);await yieldControl();signal?.throwIfAborted();
      const adata = await dec.audio.getData() as Float32Array;
      tick("decode", t0);
      const hop = adata.length / n;
      waves.push(adata.slice((ws-a)*hop,(we-a)*hop));
      decoderInput.dispose();owned.delete(decoderInput);for(const tensor of Object.values(dec)){tensor.dispose();owned.delete(tensor);}
    }
    if (pause > 0) waves.push(new Float32Array(Math.round(pause * RATE)));
    const audio = concat(waves);
    // Kelime zamanlari (karaoke icin): cercevenin soyledigi kelime, saniye olarak.
    const wlist = part.split(" "), wstarts = new Array(wlist.length).fill(null);
    fw.forEach((w, f) => { if (wstarts[w] === null) wstarts[w] = f / FPS; });
    cleanup();
    yield { audio, words: wlist, starts: wstarts.map((s) => s ?? 0), seconds: audio.length / RATE };
  }
}


return {
 async synthesize(text:string,options:{speed?:number;signal?:AbortSignal}={}):Promise<SynthesisResult>{
  const start=performance.now(),parts:Float32Array[]=[],timings:Record<string,number>={};let first:number|null=null;
  try {
   const speed=options.speed??1;if(!Number.isFinite(speed)||speed<.5||speed>2)throw new Error('Invalid EMA speed');
   for await(const p of synthPieces(text,speed,42,timings,options.signal)){
    if(first===null)first=performance.now()-start;parts.push(p.audio);
   }
   options.signal?.throwIfAborted();const audio=concat(parts);
   return {audio,sampleRate:RATE,duration:audio.length/RATE,timings:{...timings,totalMs:performance.now()-start,firstAvailableAudioMs:first??0,pieceCount:parts.length}};
  } finally {cleanup();}
 },
 async dispose(){cleanup();await Promise.all([sessText,sessSound,sessDec].map(s=>s.release()));}
};
}

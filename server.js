
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import morgan from 'morgan';
import { spawn } from 'child_process';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, 'config.json');
let cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(morgan('GET :url :status :res[content-length] - :response-time ms'));
app.use(express.json());

app.use('/streams', express.static(path.join(__dirname,'streams'),{
  acceptRanges:true,
  setHeaders:(res)=>{res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');}
}));
app.use('/', express.static(path.join(__dirname,'public')));

app.get('/health', (_req,res)=>res.json({ok:true, ts: Date.now()}));

app.get('/config.json', (_req,res)=>{
  res.set('Cache-Control','no-cache');
  res.json({ cameras: cfg.cameras });
});

function fileInfo(p){
  try{ const st = fs.statSync(p); return { size: st.size, mtime: st.mtimeMs }; }
  catch(e){ return { size:0, mtime:0 }; }
}

app.get('/api/status', (_req, res)=>{
  const list = cfg.cameras.map(c=>{
    const sdir = path.join(__dirname,'streams',c.id);
    const f = path.join(sdir,'legacy.mp4');
    const runningLegacy = legacyProcs.has(c.id);
    const runningWs = !!(wsPipelines.get(c.id));
    const wsClients = (wsClientsMap.get(c.id)||new Set()).size;
    const info = fileInfo(f);
    return {
      id: c.id, name: c.name, preset: c.preset||'balanced',
      legacyRunning: runningLegacy, wsRunning: runningWs,
      wsClients, legacySize: info.size, legacyMtime: info.mtime
    };
  });
  res.json({ cameras: list });
});

app.post('/api/cameras', (req,res)=>{
  const {id,name,rtsp,preset} = req.body||{};
  if (!id || !rtsp) return res.status(400).json({error:'id and rtsp required'});
  if (cfg.cameras.find(x=>x.id===id)) return res.status(409).json({error:'exists'});
  const cam = { id, name: name||id, rtsp, legacy:`/streams/${id}/legacy.mp4`, preset: preset||'balanced' };
  cfg.cameras.push(cam);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg,null,2));
  startLegacyMux(cam);
  res.json({ok:true, camera: cam});
});

app.delete('/api/cameras/:id', (req,res)=>{
  const id = req.params.id;
  stopLegacy(id);
  stopWs(id);
  cfg.cameras = cfg.cameras.filter(c=>c.id!==id);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg,null,2));
  res.json({ok:true});
});

app.patch('/api/cameras/:id/settings', (req,res)=>{
  const id = req.params.id;
  const cam = cfg.cameras.find(c=>c.id===id);
  if (!cam) return res.status(404).json({error:'not found'});
  const { preset, fps, bitrate, gop } = req.body||{};
  if (preset) cam.preset = preset;
  if (fps) cam.fps = fps;
  if (bitrate) cam.bitrate = bitrate;
  if (gop) cam.gop = gop;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg,null,2));
  restartLegacy(id);
  stopWs(id);
  res.json({ok:true, camera:cam});
});

function tailFile(filePath, lines=200){
  try{
    const data = fs.readFileSync(filePath, 'utf-8').split('\n');
    return data.slice(-lines).join('\n');
  }catch(e){ return ''; }
}
app.get('/api/logs/:id', (req,res)=>{
  const id = req.params.id;
  const fp = path.join(__dirname,'streams', id, 'ffmpeg.log');
  const n = parseInt(req.query.tail||'200',10);
  res.type('text/plain').send(tailFile(fp, n));
});

const legacyProcs = new Map();
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}); }
function presetVals(cam){
  const presets = cfg.ffmpeg.presets || {};
  const def = presets[cam.preset||'balanced'] || presets['balanced'] || {fps:25,bitrate:'1500k',gop:50};
  return { fps: cam.fps||def.fps, bitrate: cam.bitrate||def.bitrate, gop: cam.gop||def.gop };
}
function buildLegacyArgs(cam){
  const vals = presetVals(cam);
  const outDir = path.join(__dirname,'streams',cam.id);
  const outFile = path.join(outDir,'legacy.mp4');
  const tpl = (cfg.ffmpeg.args_legacy_template||[]).slice();
  const args = tpl.map(a => a
    .replace('__RTSP__', cam.rtsp)
    .replace('__BITRATE__', String(vals.bitrate))
    .replace('__FPS__', String(vals.fps))
    .replace('__GOP__', String(vals.gop))
    .replace('__OUT__', outFile)
  );
  return { args, outDir, outFile };
}
function startLegacyMux(cam){
  const { args, outDir, outFile } = buildLegacyArgs(cam);
  ensureDir(outDir); try{ fs.unlinkSync(outFile); }catch(_){}
  const bin = (cfg.ffmpeg && cfg.ffmpeg.binary) || 'ffmpeg';
  const proc = spawn(bin, args, { stdio:['ignore','ignore','pipe'] });
  legacyProcs.set(cam.id, proc);
  proc.stderr.on('data', (buf)=> fs.appendFile(path.join(outDir,'ffmpeg.log'), buf, ()=>{}) );
  proc.on('exit', ()=>{
    legacyProcs.delete(cam.id);
    setTimeout(()=>{
      const exists = cfg.cameras.find(c=>c.id===cam.id);
      if (exists) startLegacyMux(exists);
    }, 2000);
  });
  console.log(`[ffmpeg] legacy started ${cam.id}`);
}
function stopLegacy(id){
  const p = legacyProcs.get(id);
  if (p){ try{ p.kill('SIGTERM'); }catch(_){ } legacyProcs.delete(id); }
}
function restartLegacy(id){
  stopLegacy(id);
  const cam = cfg.cameras.find(c=>c.id===id);
  if (cam) startLegacyMux(cam);
}
for (const cam of cfg.cameras) startLegacyMux(cam);

// WebSocket H264
const wsPipelines = new Map();
const wsClientsMap = new Map();
function buildWsArgs(cam){
  const vals = presetVals(cam);
  const tpl = (cfg.ffmpeg.args_ws_template||[]).slice();
  const args = tpl.map(a => a
    .replace('__RTSP__', cam.rtsp)
    .replace('__FPS__', String(vals.fps))
    .replace('__GOP__', String(vals.gop))
  );
  return args;
}
function startWsPipeline(cam){
  if (wsPipelines.get(cam.id)) return;
  const bin = (cfg.ffmpeg && cfg.ffmpeg.binary) || 'ffmpeg';
  const args = buildWsArgs(cam);
  const proc = spawn(bin, args, { stdio:['ignore','pipe','pipe'] });
  wsPipelines.set(cam.id, proc);
  const clients = wsClientsMap.get(cam.id) || new Set();
  wsClientsMap.set(cam.id, clients);

  proc.stdout.on('data', chunk => {
    for (const ws of clients) { if (ws.readyState === 1) try{ ws.send(chunk); }catch(_){ } }
  });
  proc.stderr.on('data', ()=>{});
  proc.on('exit', ()=>{
    wsPipelines.delete(cam.id);
    for (const ws of (wsClientsMap.get(cam.id)||new Set())) { try{ ws.close(); }catch(_){ } }
    clients.clear();
  });
  console.log(`[ffmpeg] ws started ${cam.id}`);
}
function stopWs(id){
  const p = wsPipelines.get(id);
  if (p){ try{ p.kill('SIGTERM'); }catch(_){ } wsPipelines.delete(id); }
  const clients = wsClientsMap.get(id);
  if (clients){ for (const ws of clients){ try{ ws.close(); }catch(_){ } } clients.clear(); }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/ws\/([^\/]+)$/);
  if (!m) { socket.destroy(); return; }
  const camId = decodeURIComponent(m[1]);
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, camId);
  });
});

const port = cfg.port || 8081;
server.listen(port, ()=>console.log(`NVR Web v014g-ws (fix1) listening on :${port}`));

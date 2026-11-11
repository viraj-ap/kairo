// `npm run dev`: the sync server (wrangler dev, :8787), a local TURN relay (:3478) for
// peer-to-peer media between browsers on this machine, and Vite (:5173), together.
// The TURN relay matters on machines with a full-tunnel VPN (e.g. Cloudflare WARP), where
// browsers can't reach each other directly. Set VITE_ICE_SERVERS yourself to override.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import Turn from 'node-turn';

const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, 'localhost');
  });
for (const [port, what] of [[8787, 'sync server'], [5173, 'Vite']]) {
  if (!(await portFree(port))) {
    console.error(`[dev] Port ${port} (${what}) is already in use. Stop the other process first:\n      lsof -nP -iTCP:${port} -sTCP:LISTEN   # find it\n      kill <PID>`);
    process.exit(1);
  }
}

mkdirSync('dist', { recursive: true }); // wrangler's assets directory must exist

const env = { ...process.env };
if (!env.VITE_ICE_SERVERS) {
  try {
    new Turn({ listeningPort: 3478, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials: { kairo: 'kairo' }, debugLevel: 'OFF' }).start();
    env.VITE_ICE_SERVERS = JSON.stringify([{ urls: 'turn:127.0.0.1:3478?transport=udp', username: 'kairo', credential: 'kairo' }]);
    console.log('[dev] local TURN relay on 127.0.0.1:3478');
  } catch (e) {
    console.warn('[dev] could not start local TURN relay:', e.message);
  }
}

const procs = [
  spawn('npx', ['wrangler', 'dev', '--port', '8787', '--var', 'KAIRO_DEBUG:0'], { stdio: 'inherit', env }),
  spawn('npx', ['vite'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', () => (stop(), process.exit(0)));
process.on('SIGTERM', () => (stop(), process.exit(0)));
procs.forEach((p) => p.on('exit', (code) => code && (stop(), process.exit(code))));

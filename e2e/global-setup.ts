import Turn from 'node-turn';

/**
 * A self-hosted TURN relay on localhost. Two browsers on one machine normally connect over
 * host candidates, but on machines with a full-tunnel VPN (e.g. WARP) there is no direct
 * UDP path between them; TURN is also what production needs for peers behind strict NATs.
 */
export default async function globalSetup() {
  const server = new Turn({
    listeningPort: 3478,
    listeningIps: ['127.0.0.1'],
    relayIps: ['127.0.0.1'],
    authMech: 'long-term',
    credentials: { kairo: 'kairo' },
    debugLevel: 'OFF',
  });
  server.start();
  return () => server.stop();
}

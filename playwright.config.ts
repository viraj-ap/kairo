import { defineConfig } from '@playwright/test';

// Tests run against the real server: `wrangler dev` serving the built app plus the
// Durable Object relay. KAIRO_DEBUG=1 exposes /debug/room/<hash> for the security tests.
// Kairo needs H.264 WebCodecs + WebGPU: Playwright's Chrome for Testing build has both
// (the default headless shell has no hardware H.264, so proxies can't be encoded there).
// Point KAIRO_CHROME at another Chrome binary if needed.
export const PORT = 4174;
export const TEST_ICE_SERVERS = JSON.stringify([{ urls: 'turn:127.0.0.1:3478?transport=udp', username: 'kairo', credential: 'kairo' }]);

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    channel: 'chromium',
    launchOptions: {
      executablePath: process.env.KAIRO_CHROME || undefined,
      args: [
        '--enable-unsafe-webgpu',
        '--autoplay-policy=no-user-gesture-required',
        // Let two contexts on one machine reach each other over WebRTC host candidates.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: {
    command: `mkdir -p e2e/.out && npx vite build && npx wrangler dev --port ${PORT} --var KAIRO_DEBUG:1 --persist-to e2e/.out/state > e2e/.out/wrangler.log 2>&1`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { VITE_ICE_SERVERS: TEST_ICE_SERVERS },
    timeout: 180_000,
  },
});

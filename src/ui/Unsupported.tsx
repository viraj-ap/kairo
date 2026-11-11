import { navigate } from '../lib/router';

export function Unsupported() {
  return (
    <div className="center-screen">
      <img src="/logo.png" alt="" />
      <h1>Open Kairo in Chrome on desktop</h1>
      <p>
        Kairo decodes, composites and exports video on your own device using WebCodecs, WebGPU and the Origin Private
        File System. This browser doesn't provide them yet.
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => navigator.clipboard?.writeText(location.href)}>
          Copy link
        </button>
        <button className="btn" onClick={() => navigate('/')}>
          Back to dashboard
        </button>
      </div>
    </div>
  );
}

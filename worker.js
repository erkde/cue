const withIsolationHeaders = (response, isolate) => {
  const out = new Response(response.body, response);
  if (isolate) {
    out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    out.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  return out;
};

const TRANSFORMERS_VERSION = '3.8.1';
const TRANSFORMERS_DIST = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve Transformers.js same-origin so COEP permits the module worker on
    // Safari; its runtime/model fetches remain CDN/proxy-backed as before.
    if (
      url.pathname === `/lib/${TRANSFORMERS_VERSION}/transformers.min.js` ||
      url.pathname === '/lib/transformers.min.js'
    ) {
      const response = await fetch(`${TRANSFORMERS_DIST}/transformers.min.js`);
      const out = new Response(response.body, response);
      out.headers.set('Content-Type', 'application/javascript; charset=utf-8');
      out.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return withIsolationHeaders(out, true);
    }

    const versionedOrtPrefix = `/lib/${TRANSFORMERS_VERSION}/`;
    if (url.pathname.startsWith(versionedOrtPrefix) || url.pathname.startsWith('/lib/ort-')) {
      const file = url.pathname.startsWith(versionedOrtPrefix)
        ? url.pathname.slice(versionedOrtPrefix.length)
        : url.pathname.slice('/lib/'.length);
      if (!/^ort-[A-Za-z0-9._-]+$/.test(file)) return new Response('not found', { status: 404 });
      const response = await fetch(`${TRANSFORMERS_DIST}/${file}`);
      const out = new Response(response.body, response);
      out.headers.set(
        'Content-Type',
        file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript; charset=utf-8',
      );
      out.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return withIsolationHeaders(out, true);
    }

    // client-side error/crash beacons -> visible in Workers Logs
    if (url.pathname === '/log' && request.method === 'POST') {
      console.log('client-log:', (await request.text()).slice(0, 800));
      return new Response('ok');
    }

    // Proxy Hugging Face requests through your worker
    if (url.pathname.startsWith('/hf/')) {
      const target = 'https://huggingface.co/' + url.pathname.replace('/hf/', '');
      // Don't forward browser headers: HF bot-blocks browser UAs coming from
      // datacenter IPs (serves its 404 page). Range is needed for chunked
      // model downloads.
      const headers = {};
      if (request.headers.has('Range')) headers.Range = request.headers.get('Range');
      const response = await fetch(target, { headers });

      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      return withIsolationHeaders(newResponse, true);
    }

    // Serving PWA static assets. Vite's content-hashed assets are immutable;
    // stable entry points must revalidate so they can discover a new release.
    const asset = withIsolationHeaders(await env.ASSETS.fetch(request), true);
    asset.headers.set(
      'Cache-Control',
      url.pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
    );
    return asset;
  },
};

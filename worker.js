const withIsolationHeaders = (response, isolate) => {
  const out = new Response(response.body, response);
  if (isolate) {
    out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    out.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  return out;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve Transformers.js same-origin so COEP permits the module worker on
    // Safari; its runtime/model fetches remain CDN/proxy-backed as before.
    if (url.pathname === '/lib/transformers.min.js') {
      const response = await fetch(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.0/dist/transformers.min.js'
      );
      const out = new Response(response.body, response);
      out.headers.set('Content-Type', 'application/javascript; charset=utf-8');
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

    // Serving PWA static assets...
    return withIsolationHeaders(await env.ASSETS.fetch(request), true);
  }
};

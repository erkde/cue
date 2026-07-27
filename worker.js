const withIsolationHeaders = (response) => {
  const out = new Response(response.body, response);
  out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  out.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return out;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      return withIsolationHeaders(newResponse);
    }

    // Serving PWA static assets...
    return withIsolationHeaders(await env.ASSETS.fetch(request));
  }
};

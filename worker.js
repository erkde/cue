export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Proxy Hugging Face requests through your worker
    if (url.pathname.startsWith('/hf/')) {
      const target = 'https://huggingface.co/' + url.pathname.replace('/hf/', '');
      const response = await fetch(target, { headers: request.headers });

      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      return newResponse;
    }

    // Serving PWA static assets...
    return env.ASSETS.fetch(request);
  }
};

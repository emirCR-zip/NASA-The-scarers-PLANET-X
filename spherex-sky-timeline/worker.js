// Proxy CORS mínimo para Cloudflare Workers (plan gratuito).
// Solo reenvía peticiones a IRSA y agrega los encabezados que el navegador necesita.
// Uso desde la página: CONFIG.PROXY = "https://TU-WORKER.TU-USUARIO.workers.dev/?url="

const ALLOWED_HOSTS = ["irsa.ipac.caltech.edu"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return new Response("Falta el parámetro ?url=", { status: 400, headers: CORS });

    let u;
    try { u = new URL(target); } catch { return new Response("URL inválida", { status: 400, headers: CORS }); }
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.includes(u.hostname)) {
      return new Response("Host no permitido", { status: 403, headers: CORS });
    }

    const init = { method: request.method };
    if (request.method === "POST") {
      init.headers = { "Content-Type": request.headers.get("Content-Type") || "application/x-www-form-urlencoded" };
      init.body = await request.arrayBuffer();
    }

    const upstream = await fetch(u.toString(), init);
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};

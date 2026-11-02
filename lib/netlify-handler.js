const serverless = require('serverless-http');

// Adapt the existing Node HTTP application to Netlify's modern Fetch handler.
// The Node server never listens on a socket in a function invocation.
function createNetlifyHandler(createApplication) {
  let application;
  return async function handle(request, context) {
    try {
      if (!application) {
        const origin = process.env.APP_ORIGIN || context.site?.url || process.env.URL;
        application = createApplication({production:true, origin}).then(({server}) => serverless(server));
        application.catch(() => { application = undefined; });
      }
      const adapter = await application;
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') return new Response('Not found', {status:404});
      const headers = Object.fromEntries(request.headers);
      const result = await adapter({
        version:'2.0', rawPath:url.pathname, rawQueryString:url.search.slice(1), headers,
        body: ['GET','HEAD'].includes(request.method) ? '' : Buffer.from(await request.arrayBuffer()).toString('base64'),
        isBase64Encoded:true,
        requestContext:{requestId:context.requestId, http:{method:request.method,path:url.pathname,sourceIp:context.ip || 'unknown'}},
      }, {callbackWaitsForEmptyEventLoop:false});
      const responseHeaders = new Headers(result.headers);
      for (const cookie of result.cookies || []) responseHeaders.append('set-cookie',cookie);
      for (const [key,values] of Object.entries(result.multiValueHeaders || {})) {
        responseHeaders.delete(key);
        for (const value of values) responseHeaders.append(key,value);
      }
      return new Response(request.method === 'HEAD' ? null : result.isBase64Encoded ? Buffer.from(result.body || '', 'base64') : result.body, {status:result.statusCode, headers:responseHeaders});
    } catch (error) {
      console.error('API initialization failed:', error.message);
      const allowed = new Set(['28P01','28000','ENOTFOUND','ECONNREFUSED','ETIMEDOUT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT']);
      const code = allowed.has(error.code) ? error.code : /DATABASE_URL is required/.test(error.message) ? 'DATABASE_URL_MISSING' : /APP_ORIGIN is required/.test(error.message) ? 'APP_ORIGIN_MISSING' : /Invalid URL|Invalid connection string/.test(error.message) ? 'DATABASE_URL_INVALID' : 'STARTUP_FAILED';
      return Response.json({error:'The shared database is not configured or could not be reached. Please contact the workspace administrator.',code}, {status:503, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
  };
}
module.exports = { createNetlifyHandler };

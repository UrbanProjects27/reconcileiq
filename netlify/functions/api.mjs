import application from '../../server.js';
import adapter from '../../lib/netlify-handler.js';

export default adapter.createNetlifyHandler(application.createApplication);
export const config = {path: ['/api/*', '/health']};

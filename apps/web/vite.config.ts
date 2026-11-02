import {defineConfig} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';

const port = 5173;
const backend = 'http://127.0.0.1:4318';
const trustedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const trustedOrigins = new Set([...trustedHosts].map(host => `http://${host}`));
const loopbackOnly = {
  name: 'workbench-loopback-dev-boundary',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Validate the browser-side boundary before the trusted proxy rewrites it.
      if (!trustedHosts.has(req.headers.host) || (req.headers.origin && !trustedOrigins.has(req.headers.origin))) {
        res.statusCode = 403;res.end('Local development origin rejected');return;
      }
      next();
    });
  },
};
const proxy = () => ({
  target: backend,
  changeOrigin: true,
  configure(server) {
    server.on('proxyReq', (request, source) => {
      if (source.headers.origin) request.setHeader('origin', backend);
    });
  },
});
export default defineConfig(() => ({
  plugins: [loopbackOnly, tailwindcss()],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {host: '127.0.0.1',port,strictPort:true,cors:false,proxy:{'/api':proxy(),'/media':proxy(),'/health':proxy()}},
  build: {outDir: 'dist', emptyOutDir:true},
}));

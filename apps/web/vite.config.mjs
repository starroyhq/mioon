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
export default defineConfig(({mode}) => {
  // A separate build artifact is the only UI entry selector. It is never read
  // from a workspace response, query parameter or browser storage.
  const opacityCandidate = mode === 'opacity-candidate';
  const candidateEntry = {
    name: 'mioon-internal-opacity-candidate-entry',
    generateBundle() {
      this.emitFile({type: 'asset', fileName: 'mioon-opacity-candidate-entry.json',
        source: JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}) + '\n'});
    },
  };
  return {
  plugins: [loopbackOnly, tailwindcss(), ...(opacityCandidate ? [candidateEntry] : [])],
  define: {__MIOON_INTERNAL_OPACITY_CANDIDATE__: JSON.stringify(opacityCandidate)},
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {host: '127.0.0.1',port,strictPort:true,cors:false,proxy:{'/api':proxy(),'/media':proxy(),'/health':proxy()}},
  build: {outDir: opacityCandidate ? 'dist-opacity-candidate' : 'dist', emptyOutDir:true,
    ...(opacityCandidate ? {rollupOptions: {input: fileURLToPath(new URL('./opacity-candidate.html', import.meta.url))}} : {})},
  };
});

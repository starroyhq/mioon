import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Builds the screenshot gallery (gallery/) on its own with Vite's JS API.
 * It never reads apps/web/vite.config.ts and never goes into a product build.
 * Usage: node tests/fixtures/project-file-ui/build-gallery.ts [--out <dir>] */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const argument = process.argv.indexOf('--out');
const out = argument > 0 && process.argv[argument + 1] ? resolve(process.argv[argument + 1]) : '/private/tmp/u1-project-file-ui/gallery-dist';
const web = createRequire(join(root, 'apps/web/package.json'));
const { build } = await import(web.resolve('vite')) as { build: (config: Record<string, unknown>) => Promise<unknown> };
const tailwind = (await import(web.resolve('@tailwindcss/vite')) as { default: () => unknown }).default;
const started = Date.now();
try {
  await build({
    configFile: false, root: join(here, 'gallery'), base: './', logLevel: 'warn', mode: 'production',
    cacheDir: join(dirname(out), 'gallery-vite-cache'),
    plugins: [tailwind()],
    resolve: { alias: { react: join(root, 'apps/web/node_modules/react'), 'react-dom': join(root, 'apps/web/node_modules/react-dom') }, dedupe: ['react', 'react-dom'] },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: out, emptyOutDir: true, reportCompressedSize: false, chunkSizeWarningLimit: 4096,
      // Base UI's "use client" directives mean nothing to a static bundle; the source map notes come with them.
      rollupOptions: { onwarn(warning: { code?: string }, warn: (warning: { code?: string }) => void) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE' && warning.code !== 'SOURCEMAP_ERROR') warn(warning); } } },
  });
  console.log(`gallery built in ${Date.now() - started} ms: ${out}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

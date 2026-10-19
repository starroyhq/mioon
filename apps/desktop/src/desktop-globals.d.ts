// Build-injected constants. esbuild replaces these identifiers at bundle time
// (apps/desktop/scripts/build.ts defines __MIOON_DESKTOP_CHANNEL__ from the
// reviewed identity module). They are never read from the environment.
declare const __MIOON_DESKTOP_CHANNEL__: 'production' | 'development';

export function isWarmSettingsScriptPath(pathname: string): boolean {
  return /^\/assets\/(?:settings|settings-boot-close)-[\w-]{8}\.js$/.test(pathname);
}

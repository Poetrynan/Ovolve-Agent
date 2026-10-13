// Sync workspace folders to Electron's path fence (pathScope.ts).
// Sidebar / backend workspace switches are user intent, same as a native dialog pick.

export function grantWorkspacesToMain(...paths: (string | undefined | null)[]): void {
  const api = window.electronAPI
  if (!api?.isElectron) return
  const unique = [...new Set(
    paths
      .map((p) => (p || '').trim())
      .filter((p) => p && p !== '.' && p !== './' && p !== '.\\'),
  )]
  void api.invoke('workspace:grant', unique).catch(() => {})
}

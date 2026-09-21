/**
 * Render Ovolve brand icons into public/ (PNG) for Electron + Windows.
 * Uses ovolve-icon.svg artwork — distinct from Ovolve ribbon-V mark.
 */
const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const OVOLVE_SVG = `
<svg width="1024" height="1024" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ovolve-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0052ff"/>
      <stop offset="33%" stop-color="#00d2ff"/>
      <stop offset="66%" stop-color="#9b51e0"/>
      <stop offset="100%" stop-color="#ff5e7e"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#ovolve-grad)"/>
  <circle cx="32" cy="32" r="14" fill="none" stroke="white" stroke-width="3" stroke-dasharray="6 4"/>
  <circle cx="32" cy="18" r="4" fill="white"/>
  <circle cx="18" cy="40" r="4" fill="white" opacity="0.8"/>
  <circle cx="46" cy="40" r="4" fill="white" opacity="0.8"/>
</svg>
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  })

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  body{margin:0;padding:0;width:1024px;height:1024px;background:transparent;
  display:flex;align-items:center;justify-content:center;overflow:hidden}
</style></head><body>${OVOLVE_SVG}</body></html>`

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 250))

  const pngBuf = (await win.webContents.capturePage()).toPNG()
  const publicDir = path.join(__dirname, '../public')
  const targets = ['icon.png', 'splash-icon.png']
  for (const name of targets) {
    fs.writeFileSync(path.join(publicDir, name), pngBuf)
  }

  const pngPath = path.join(publicDir, 'icon.png')
  const pyScript = path.join(__dirname, 'png_to_ico.py')
  const py = spawnSync(
    process.env.PYTHON || 'python',
    [pyScript, pngPath, path.join(publicDir, 'icon.ico'), path.join(publicDir, 'splash-icon.ico')],
    { encoding: 'utf8' },
  )
  if (py.status !== 0) {
    console.error('[render_icons] ICO generation failed:', py.stderr || py.stdout)
    process.exitCode = 1
    app.quit()
    return
  }

  console.log('[render_icons] Wrote icon.png, icon.ico, splash-icon.* (Ovolve brand)')
  app.quit()
})

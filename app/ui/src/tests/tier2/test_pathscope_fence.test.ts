// src/tests/tier2/test_pathscope_fence.test.ts
// Regression tests for the main-process filesystem fence (electron/pathScope.ts).
//
// Before the fence, `file:readText` / `file:writeText` / `git:run` took an
// absolute path straight from the renderer and handed it to fs / spawn. These
// tests pin the four ways that fence can be wrong: string-prefix confusion,
// link escapes, paths that do not exist yet, and lost grants across restarts.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ovolve-scope-'))
const configRoot = path.join(tmpBase, 'config')
const ws = path.join(tmpBase, 'ws')
const outside = path.join(tmpBase, 'outside')
// Same string prefix as `ws`, but a different directory: `startsWith(root)`
// without a separator guard would wrongly accept everything under it.
const wsSibling = path.join(tmpBase, 'ws-evil')

for (const d of [configRoot, ws, outside, wsSibling]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(ws, 'inside.txt'), 'ok', 'utf-8')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'sensitive', 'utf-8')
fs.writeFileSync(path.join(wsSibling, 'secret.txt'), 'sensitive', 'utf-8')

/** Fresh module instance so each test starts from a known grant set. */
async function loadScope(root: string = configRoot) {
  vi.resetModules()
  const mod = await import('../../../electron/pathScope')
  mod.initPathScope(root)
  return mod
}

/** Directory link, if this platform/account can make one. */
function tryDirLink(linkPath: string, target: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, 'junction')
    return true
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'dir')
      return true
    } catch {
      return false
    }
  }
}

describe('pathScope: granted roots', () => {
  let scope: Awaited<ReturnType<typeof loadScope>>

  beforeEach(async () => {
    scope = await loadScope()
    scope.grantRoot(ws)
  })

  it('allows a file inside a granted root', () => {
    expect(scope.scopedPath(path.join(ws, 'inside.txt'))).toBe(path.join(ws, 'inside.txt'))
  })

  it('allows the configRoot without an explicit grant', () => {
    expect(() => scope.scopedPath(path.join(configRoot, 'setting.json'))).not.toThrow()
  })

  it('allows a write target that does not exist yet', () => {
    // realpath throws on missing paths; the fence must resolve the deepest
    // existing ancestor instead of failing the whole check.
    expect(() => scope.scopedPath(path.join(ws, 'new', 'deep', 'file.txt'))).not.toThrow()
  })

  it('denies a path outside every granted root', () => {
    expect(() => scope.scopedPath(path.join(outside, 'secret.txt'))).toThrow(/超出已授权目录/)
  })

  it('denies a sibling directory that merely shares the name prefix', () => {
    expect(() => scope.scopedPath(path.join(wsSibling, 'secret.txt'))).toThrow(/超出已授权目录/)
  })

  it('denies traversal that climbs out with ..', () => {
    expect(() => scope.scopedPath(path.join(ws, '..', 'outside', 'secret.txt'))).toThrow(
      /超出已授权目录/,
    )
  })

  it('denies empty, non-string and NUL-bearing paths', () => {
    expect(() => scope.scopedPath('')).toThrow()
    expect(() => scope.scopedPath('   ')).toThrow()
    expect(() => scope.scopedPath(undefined)).toThrow()
    expect(() => scope.scopedPath(42)).toThrow()
    expect(() => scope.scopedPath(path.join(ws, 'a\0b'))).toThrow(/非法字符/)
  })

  it('denies a link inside the workspace whose target escapes it', () => {
    const link = path.join(ws, 'escape-link')
    if (!tryDirLink(link, outside)) return // no link privilege on this runner
    // Purely textual normalization reports this as inside `ws`.
    expect(() => scope.scopedPath(path.join(link, 'secret.txt'))).toThrow(/超出已授权目录/)
    fs.rmSync(link, { recursive: true, force: true })
  })
})

describe('pathScope: grant persistence', () => {
  it('restores grants made in an earlier run', async () => {
    // Its own config dir, so grants from the suite above cannot leak in.
    const isolated = path.join(tmpBase, 'config-persist')
    fs.mkdirSync(isolated, { recursive: true })

    const first = await loadScope(isolated)
    expect(() => first.scopedPath(path.join(ws, 'inside.txt'))).toThrow()
    first.grantRoot(ws)
    expect(fs.existsSync(path.join(isolated, 'granted-roots.json'))).toBe(true)

    // Simulate an app restart: brand new module state, same configRoot.
    const second = await loadScope(isolated)
    expect(() => second.scopedPath(path.join(ws, 'inside.txt'))).not.toThrow()
    expect(() => second.scopedPath(path.join(outside, 'secret.txt'))).toThrow()
  })

  it('ignores blank grants instead of widening the fence', async () => {
    const isolated = path.join(tmpBase, 'config-blank')
    fs.mkdirSync(isolated, { recursive: true })
    const scope = await loadScope(isolated)
    const before = scope.grantedRoots().length
    scope.grantRoot('')
    scope.grantRoot(null)
    scope.grantRoot(undefined)
    expect(scope.grantedRoots().length).toBe(before)
  })
})

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

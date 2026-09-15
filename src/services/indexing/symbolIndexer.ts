import fs from 'node:fs'
import path from 'node:path'

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'struct' | 'method'

export interface CodeSymbol {
  name: string
  kind: SymbolKind
  relativePath: string
  line: number
  signature: string
  docstring?: string
}

export class ASTSymbolIndexer {
  private static instance: ASTSymbolIndexer
  private symbols: Map<string, CodeSymbol[]> = new Map() // name -> array of symbols (since same name can exist in different files)
  private allSymbolList: CodeSymbol[] = []

  public static getInstance(): ASTSymbolIndexer {
    if (!ASTSymbolIndexer.instance) {
      ASTSymbolIndexer.instance = new ASTSymbolIndexer()
    }
    return ASTSymbolIndexer.instance
  }

  /**
   * Extract code symbols from file content using robust regex AST parsing
   */
  public extractSymbolsFromSource(relativePath: string, content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = []
    const lines = content.split(/\r?\n/)
    const ext = path.extname(relativePath).toLowerCase()

    // TypeScript / JavaScript
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
      lines.forEach((line, idx) => {
        const lineNum = idx + 1
        const trimmed = line.trim()

        // Classes
        const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/)
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', relativePath, line: lineNum, signature: trimmed })
          return
        }

        // Interfaces
        const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/)
        if (ifaceMatch) {
          symbols.push({ name: ifaceMatch[1], kind: 'interface', relativePath, line: lineNum, signature: trimmed })
          return
        }

        // Types
        const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/)
        if (typeMatch) {
          symbols.push({ name: typeMatch[1], kind: 'type', relativePath, line: lineNum, signature: trimmed })
          return
        }

        // Functions
        const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/)
        if (fnMatch) {
          symbols.push({ name: fnMatch[1], kind: 'function', relativePath, line: lineNum, signature: trimmed })
          return
        }

        // Arrow functions / const functions
        const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\(/)
        if (arrowMatch) {
          symbols.push({ name: arrowMatch[1], kind: 'function', relativePath, line: lineNum, signature: trimmed })
          return
        }

        // Enums
        const enumMatch = trimmed.match(/^(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)/)
        if (enumMatch) {
          symbols.push({ name: enumMatch[1], kind: 'enum', relativePath, line: lineNum, signature: trimmed })
          return
        }
      })
    }

    // Python
    else if (ext === '.py') {
      lines.forEach((line, idx) => {
        const lineNum = idx + 1
        const trimmed = line.trim()

        const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/)
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', relativePath, line: lineNum, signature: trimmed })
          return
        }

        const fnMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/)
        if (fnMatch) {
          const isMethod = line.startsWith('    ') || line.startsWith('\t')
          symbols.push({
            name: fnMatch[1],
            kind: isMethod ? 'method' : 'function',
            relativePath,
            line: lineNum,
            signature: trimmed,
          })
          return
        }
      })
    }

    // Rust
    else if (ext === '.rs') {
      lines.forEach((line, idx) => {
        const lineNum = idx + 1
        const trimmed = line.trim()

        const structMatch = trimmed.match(/^(?:pub\s+)?struct\s+([a-zA-Z0-9_]+)/)
        if (structMatch) {
          symbols.push({ name: structMatch[1], kind: 'struct', relativePath, line: lineNum, signature: trimmed })
          return
        }

        const enumMatch = trimmed.match(/^(?:pub\s+)?enum\s+([a-zA-Z0-9_]+)/)
        if (enumMatch) {
          symbols.push({ name: enumMatch[1], kind: 'enum', relativePath, line: lineNum, signature: trimmed })
          return
        }

        const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/)
        if (fnMatch) {
          symbols.push({ name: fnMatch[1], kind: 'function', relativePath, line: lineNum, signature: trimmed })
          return
        }
      })
    }

    return symbols
  }

  /**
   * Index an entire workspace directory
   */
  public async indexWorkspace(workspaceRoot: string, maxFiles = 2000): Promise<number> {
    this.symbols.clear()
    this.allSymbolList = []

    const validExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go'])
    let scannedFiles = 0

    const walk = (dir: string) => {
      if (scannedFiles >= maxFiles) return
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') {
          continue
        }

        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (validExts.has(ext)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf-8')
              const rel = path.relative(workspaceRoot, fullPath)
              const fileSymbols = this.extractSymbolsFromSource(rel, content)

              for (const sym of fileSymbols) {
                if (!this.symbols.has(sym.name.toLowerCase())) {
                  this.symbols.set(sym.name.toLowerCase(), [])
                }
                this.symbols.get(sym.name.toLowerCase())!.push(sym)
                this.allSymbolList.push(sym)
              }
              scannedFiles++
            } catch {}
          }
        }
      }
    }

    walk(workspaceRoot)
    return this.allSymbolList.length
  }

  /**
   * Fast fuzzy search for symbols matching query (powers @symbol popup)
   */
  public searchSymbols(query: string, limit = 15): CodeSymbol[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.allSymbolList.slice(0, limit)

    const matches: CodeSymbol[] = []
    for (const sym of this.allSymbolList) {
      if (sym.name.toLowerCase().includes(q)) {
        matches.push(sym)
        if (matches.length >= limit) break
      }
    }
    return matches
  }

  public getSymbolCount(): number {
    return this.allSymbolList.length
  }
}

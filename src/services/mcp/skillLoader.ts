import fs from 'node:fs'
import path from 'node:path'

export interface AgentSkill {
  name: string
  description: string
  dirPath: string
  skillFilePath: string
  fullContent?: string
}

export class SkillLoader {
  private static instance: SkillLoader
  private skills: Map<string, AgentSkill> = new Map()

  public static getInstance(): SkillLoader {
    if (!SkillLoader.instance) {
      SkillLoader.instance = new SkillLoader()
    }
    return SkillLoader.instance
  }

  /**
   * Parse YAML frontmatter from SKILL.md
   */
  public parseSkillMarkdown(content: string, dirPath: string, skillFilePath: string): AgentSkill | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return null

    const yamlBlock = match[1]
    let name = path.basename(dirPath)
    let description = ''

    const nameMatch = yamlBlock.match(/name:\s*([^\r\n]+)/)
    if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')

    const descMatch = yamlBlock.match(/description:\s*([^\r\n]+)/)
    if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, '')

    return {
      name,
      description,
      dirPath,
      skillFilePath,
    }
  }

  /**
   * Discover and register skills from local workspace directory (.ovolve/skills or .agents/skills)
   */
  public scanSkills(workspaceRoot: string): AgentSkill[] {
    this.skills.clear()
    const possibleDirs = [
      path.join(workspaceRoot, '.ovolve', 'skills'),
      path.join(workspaceRoot, '.agents', 'skills'),
    ]

    for (const baseDir of possibleDirs) {
      if (!fs.existsSync(baseDir)) continue

      try {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillFile = path.join(baseDir, entry.name, 'SKILL.md')
            if (fs.existsSync(skillFile)) {
              try {
                const content = fs.readFileSync(skillFile, 'utf-8')
                const skill = this.parseSkillMarkdown(content, path.join(baseDir, entry.name), skillFile)
                if (skill) {
                  this.skills.set(skill.name, skill)
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    return Array.from(this.skills.values())
  }

  /**
   * Build compact skill catalog snippet for System Prompt
   */
  public buildSystemPromptCatalog(): string {
    if (this.skills.size === 0) return ''

    let out = '## Available Skills (On-Demand):\n'
    for (const skill of this.skills.values()) {
      out += `- **${skill.name}**: ${skill.description}\n`
    }
    out += '\nWhen a skill is relevant, view its SKILL.md to load full detailed procedures.'
    return out
  }

  public getSkill(name: string): AgentSkill | undefined {
    return this.skills.get(name)
  }

  public loadFullSkillContent(name: string): string | null {
    const skill = this.skills.get(name)
    if (!skill) return null
    try {
      return fs.readFileSync(skill.skillFilePath, 'utf-8')
    } catch {
      return null
    }
  }
}

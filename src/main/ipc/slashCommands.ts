import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Discovers the real slash commands available to the Claude Code CLI so the
 * chat can autocomplete them: user/project custom commands (`.claude/commands/*.md`)
 * and skills (`.claude/skills/<name>/SKILL.md`, invoked as `/<name>`). When the
 * user picks one, we pass the raw `/command args` text to the Agent SDK, which
 * resolves and executes it natively (we load user+project+local setting sources).
 */

export interface SlashCommand {
  name: string // includes leading slash, e.g. "/review"
  description: string
  source: 'user' | 'project' | 'skill' | 'client'
}

function parseFrontmatterDescription(raw: string): string {
  // Supports `description: ...` and block scalar `description: |`.
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = fm ? fm[1] : raw.slice(0, 400)
  const inline = body.match(/^description:\s*(.+)$/m)
  if (inline && inline[1].trim() !== '|' && inline[1].trim() !== '>') {
    return inline[1].trim().replace(/^["']|["']$/g, '')
  }
  const block = body.match(/^description:\s*[|>]\s*\r?\n([\s\S]*?)(?:\r?\n\S|$)/m)
  if (block) return block[1].trim().split(/\r?\n/)[0].trim()
  return ''
}

async function readCommandsDir(dir: string, source: 'user' | 'project'): Promise<SlashCommand[]> {
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const name = '/' + f.replace(/\.md$/, '')
    let description = ''
    try {
      description = parseFrontmatterDescription(await fs.readFile(join(dir, f), 'utf8'))
    } catch {
      /* ignore */
    }
    out.push({ name, description, source })
  }
  return out
}

async function readSkills(dir: string): Promise<SlashCommand[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    let description = ''
    try {
      description = parseFrontmatterDescription(await fs.readFile(join(dir, ent.name, 'SKILL.md'), 'utf8'))
    } catch {
      continue
    }
    out.push({ name: '/' + ent.name, description, source: 'skill' })
  }
  return out
}

export function registerSlashCommandHandlers(): void {
  ipcMain.handle('commands:list', async (_e, projectDir?: string) => {
    const home = homedir()
    const groups = await Promise.all([
      readCommandsDir(join(home, '.claude', 'commands'), 'user'),
      readSkills(join(home, '.claude', 'skills')),
      projectDir ? readCommandsDir(join(projectDir, '.claude', 'commands'), 'project') : Promise.resolve([])
    ])
    const seen = new Set<string>()
    const all: SlashCommand[] = []
    for (const g of groups) {
      for (const c of g) {
        if (seen.has(c.name)) continue
        seen.add(c.name)
        all.push(c)
      }
    }
    all.sort((a, b) => a.name.localeCompare(b.name))
    return all
  })
}

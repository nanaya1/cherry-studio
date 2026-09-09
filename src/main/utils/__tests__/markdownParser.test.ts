import * as fs from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  findSkillIconFileName,
  parsePluginMetadata,
  parseSkillMetadata,
  skillMdHasFrontmatterKey
} from '../markdownParser'

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn()
  }
}))

vi.mock('../fileOperations', () => ({
  getDirectorySize: vi.fn().mockResolvedValue(123)
}))

describe('markdownParser', () => {
  const pluginContent = `---
name: bad-plugin
description: Use this agent when example: user: "hi"
tools: ["Read", "Grep"]
---

Body`

  const skillContent = `---
name: bad-skill
description: Use this skill when example: user: "hi"
tools: Read, Grep
---

Body`

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.promises.stat).mockResolvedValue({ size: 42 } as fs.Stats)
    vi.mocked(fs.promises.lstat).mockRejectedValue(new Error('ENOENT'))
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).includes('SKILL.md')) {
        return skillContent
      }
      return pluginContent
    })
  })

  it('throws an Error with metadata when the skill folder path is invalid', async () => {
    const promise = parseSkillMetadata('relative/skill', 'skills/bad-skill', 'skills')

    await expect(promise).rejects.toBeInstanceOf(Error)
    await expect(promise).rejects.toMatchObject({
      name: 'PluginError',
      type: 'INVALID_METADATA',
      path: 'relative/skill',
      message: 'Skill folder path must be absolute'
    })
  })

  it('throws an Error with metadata when the skill markdown file is missing', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'))
    const promise = parseSkillMetadata('/abs/missing-skill', 'skills/missing-skill', 'skills')

    await expect(promise).rejects.toBeInstanceOf(Error)
    await expect(promise).rejects.toMatchObject({
      name: 'PluginError',
      type: 'FILE_NOT_FOUND',
      path: '/abs/missing-skill/SKILL.md',
      message: 'SKILL.md or skill.md not found in skill folder'
    })
  })

  it('throws an Error with metadata when the skill markdown file cannot be read', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('EACCES'))
    const promise = parseSkillMetadata('/abs/unreadable-skill', 'skills/unreadable-skill', 'skills')

    await expect(promise).rejects.toBeInstanceOf(Error)
    await expect(promise).rejects.toMatchObject({
      name: 'PluginError',
      type: 'READ_FAILED',
      path: '/abs/unreadable-skill/SKILL.md',
      message: 'EACCES'
    })
  })

  it('recovers invalid plugin frontmatter and keeps metadata', async () => {
    const metadata = await parsePluginMetadata('/abs/plugin.md', 'plugins/plugin.md', 'plugins', 'agent')
    expect(metadata.name).toBe('bad-plugin')
    expect(metadata.description).toContain('example: user')
    expect(metadata.tools).toEqual(['Read', 'Grep'])
  })

  it('recovers invalid skill frontmatter and keeps metadata', async () => {
    const metadata = await parseSkillMetadata('/abs/skill', 'skills/bad-skill', 'skills')
    expect(metadata.name).toBe('bad-skill')
    expect(metadata.description).toContain('example: user')
    expect(metadata.tools).toEqual(['Read', 'Grep'])
  })

  it('reads skill runtime fields and nested metadata version', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: parallel-web-search
slug: parallel-web-search
context: fork
agent: parallel:parallel-subagent
allowed-tools: Bash(parallel-cli:*)
metadata:
  version: "1.0.12"
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/git', 'skills')

    expect(metadata.slug).toBe('parallel-web-search')
    expect(metadata.version).toBe('1.0.12')
    expect(metadata).toMatchObject({
      context: 'fork',
      agent: 'parallel:parallel-subagent',
      allowed_tools: ['Bash(parallel-cli:*)']
    })
  })

  it('prefers a top-level skill version over metadata.version', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: versioned-skill
version: "2.0.0"
metadata:
  version: "1.0.0"
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/versioned-skill', 'skills')

    expect(metadata.version).toBe('2.0.0')
  })

  it('parses display_name and keeps name as the identifier', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: xiao-ying-work-rules
display_name: 小樱的工作准则
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/xiao-ying-work-rules', 'skills')

    expect(metadata.name).toBe('xiao-ying-work-rules')
    expect(metadata.displayName).toBe('小樱的工作准则')
    expect(metadata.displayNameEn).toBeNull()
  })

  it('parses display_name_en and accepts camelCase variants', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: xiao-ying-work-rules
display_name: 小樱的工作准则
displayNameEn: "  Sakura Work Rules  "
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/xiao-ying-work-rules', 'skills')

    expect(metadata.displayName).toBe('小樱的工作准则')
    expect(metadata.displayNameEn).toBe('Sakura Work Rules')
  })

  it('accepts camelCase displayName and trims surrounding whitespace', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: my-skill
displayName: "  Fancy Skill  "
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/my-skill', 'skills')

    expect(metadata.displayName).toBe('Fancy Skill')
  })

  it('normalizes an absent or blank display_name to null', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: plain-skill
display_name: ""
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/plain-skill', 'skills')

    expect(metadata.name).toBe('plain-skill')
    expect(metadata.displayName).toBeNull()
  })

  it('caps an oversized display_name at 100 characters', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: long-skill
display_name: "${'长'.repeat(150)}"
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/long-skill', 'skills')

    expect(metadata.displayName).toHaveLength(100)
  })

  it('detects a display_name key in SKILL.md without full parsing', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue({} as fs.Stats)
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: labeled-skill
display_name: '机械设计知识查询助手'
---

Body`)

    await expect(skillMdHasFrontmatterKey('/abs/skill', 'display_name')).resolves.toBe(true)
    await expect(skillMdHasFrontmatterKey('/abs/skill', 'display_name_en')).resolves.toBe(false)

    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: labeled-skill
display_name_en: 'Mechanical Design Assistant'
---

Body`)

    await expect(skillMdHasFrontmatterKey('/abs/skill', 'display_name')).resolves.toBe(false)
    await expect(skillMdHasFrontmatterKey('/abs/skill', 'display_name_en')).resolves.toBe(true)

    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: plain-skill
description: no display label
---

Body`)

    await expect(skillMdHasFrontmatterKey('/abs/skill', 'display_name')).resolves.toBe(false)
    await expect(skillMdHasFrontmatterKey('/abs/skill', 'display_name_en')).resolves.toBe(false)
  })

  it('detects a description_en key in SKILL.md without full parsing', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue({} as fs.Stats)

    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: labeled-skill
description_en: 'English description'
---

Body`)

    await expect(skillMdHasFrontmatterKey('/abs/skill', 'description_en')).resolves.toBe(true)

    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: plain-skill
description: 中文描述
---

Body`)

    await expect(skillMdHasFrontmatterKey('/abs/skill', 'description_en')).resolves.toBe(false)
  })

  it('parses description_en and accepts camelCase variants', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: my-skill
description: 中文描述
descriptionEn: "  English description  "
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/my-skill', 'skills')

    expect(metadata.description).toBe('中文描述')
    expect(metadata.descriptionEn).toBe('English description')
  })

  it('normalizes an absent or blank description_en to undefined', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(`---
name: plain-skill
description: 中文描述
description_en: "   "
---

Body`)

    const metadata = await parseSkillMetadata('/abs/skill', 'skills/plain-skill', 'skills')

    expect(metadata.description).toBe('中文描述')
    expect(metadata.descriptionEn).toBeUndefined()
  })

  it.each(['icon.webp', 'icon.png', 'icon.jpg', 'icon.jpeg'])(
    'detects supported root skill icon %s',
    async (fileName) => {
      vi.mocked(fs.promises.lstat).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(fileName)) return { isFile: () => true } as fs.Stats
        throw new Error('ENOENT')
      })

      await expect(findSkillIconFileName('/abs/skill')).resolves.toBe(fileName)
    }
  )

  it('prefers WebP when several supported skill icons exist', async () => {
    vi.mocked(fs.promises.lstat).mockResolvedValue({ isFile: () => true } as fs.Stats)

    await expect(findSkillIconFileName('/abs/skill')).resolves.toBe('icon.webp')
  })
})

// 工业视频分镜「兼容性验证」纯逻辑模块（无 React 依赖，可独立契约测试）。
// 分镜结构等价 MCP storyboard_schema：prompt_en 无中日韩文字、时长 5-15、旁白 26 字；
// 额外加入 scene id 唯一性与旁白时间（start < end）校验。
// 该模块不创建 session / run / 上传 / 提交 / 生成，仅做本地只读校验与差异比较。

import * as z from 'zod'

export const storyboardNarrationSchema = z
  .object({
    text: z.string().min(1).max(26),
    start: z.number().min(0),
    end: z.number().min(0)
  })
  .refine((narration) => narration.start < narration.end, {
    message: '旁白起始时间须早于结束时间',
    path: ['start']
  })

export const storyboardSceneSchema = z
  .looseObject({
    id: z.number().int().min(1),
    title: z.string().min(1).max(12),
    duration: z.number().int().min(5).max(15),
    prompt: z.string().min(1).max(20000),
    prompt_en: z
      .string()
      .min(20)
      .max(20000)
      .regex(/[A-Za-z]/, 'prompt_en 须包含英文字母')
      .regex(
        /^[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]*$/u,
        'prompt_en 不得包含中日韩文字'
      ),
    narration: z.array(storyboardNarrationSchema).max(4)
  })
  .superRefine((scene, ctx) => {
    scene.narration.forEach((narration, index) => {
      if (narration.end > scene.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `旁白结束时间 ${narration.end} 超出镜头时长 ${scene.duration}`,
          path: ['narration', index, 'end']
        })
      }
    })
  })

export const storyboardSchema = z
  .looseObject({
    video_title: z.string().regex(/\S/).max(120),
    scenes: z.array(storyboardSceneSchema).min(1).max(100)
  })
  .superRefine((value, ctx) => {
    const seen = new Set<number>()
    value.scenes.forEach((scene, index) => {
      if (seen.has(scene.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene id ${scene.id} 重复`,
          path: ['scenes', index, 'id']
        })
      }
      seen.add(scene.id)
    })
  })

export type Storyboard = z.infer<typeof storyboardSchema>
export type StoryboardScene = z.infer<typeof storyboardSceneSchema>
export type StoryboardNarration = z.infer<typeof storyboardNarrationSchema>

export type ValidationResult = { ok: true; data: Storyboard } | { ok: false; errors: string[] }

export function validateStoryboard(value: unknown): ValidationResult {
  const result = storyboardSchema.safeParse(value)
  if (result.success) return { ok: true, data: result.data }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
}

export type ParseResult = { ok: true; data: Storyboard } | { ok: false; error: string; errors?: string[] }

// 容错解析模型返回的 JSON 文本：允许 ```json 代码围栏与首尾空白。
export function parseStoryboardText(text: string): ParseResult {
  const json = extractJson(text)
  if (json === null) return { ok: false, error: '无法解析为 JSON 分镜' }
  const result = validateStoryboard(json)
  if (result.ok) return result
  return { ok: false, error: result.errors.join('; '), errors: result.errors }
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fence ? fence[1] : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

export interface DiffEntry {
  path: string
  before: unknown
  after: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(base: string, segment: string): string {
  return base ? `${base}/${segment}` : `/${segment}`
}

// 递归比较前后分镜，记录所有发生变化的叶子路径（含结构性增删）。
export function computeStoryboardDiff(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = []
  walk(before, after, '', out)
  return out
}

function walk(a: unknown, b: unknown, base: string, out: DiffEntry[]): void {
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr && bArr) {
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i++) {
      const ai = a[i]
      const bi = b[i]
      if (i >= a.length || i >= b.length) {
        out.push({ path: joinPath(base, String(i)), before: ai, after: bi })
      } else {
        walk(ai, bi, joinPath(base, String(i)), out)
      }
    }
    return
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!(key in a) || !(key in b)) {
        out.push({ path: joinPath(base, key), before: a[key], after: b[key] })
      } else {
        walk(a[key], b[key], joinPath(base, key), out)
      }
    }
    return
  }
  if (a !== b) {
    out.push({ path: base || '/', before: a, after: b })
  }
}

export type NormalizePathsResult = { ok: true; paths: string[] } | { ok: false; error: string }

// 规范化允许修改的 JSON 路径集合：非空、不能以根路径放开所有字段。
export function normalizeAllowedPaths(raw: string): NormalizePathsResult {
  const parts = raw
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    return { ok: false, error: '允许修改的 JSON 路径不能为空' }
  }
  const paths: string[] = []
  for (const part of parts) {
    let normalized = part.startsWith('/') ? part : `/${part}`
    normalized = normalized.replace(/\/+$/, '')
    if (normalized === '' || normalized === '/') {
      return { ok: false, error: '允许路径不能以根路径放开所有字段' }
    }
    paths.push(normalized)
  }
  return { ok: true, paths }
}

export type ModificationVerdict = { ok: true } | { ok: false; rejectedPaths: string[] }

function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))
}

// 判定定向修改是否越界：任一变更路径不在允许集合内即拒绝。
export function isAllowableModification(diff: DiffEntry[], allowedPaths: string[]): ModificationVerdict {
  const rejectedPaths = diff.filter((entry) => !isPathAllowed(entry.path, allowedPaths)).map((entry) => entry.path)
  if (rejectedPaths.length === 0) return { ok: true }
  return { ok: false, rejectedPaths }
}

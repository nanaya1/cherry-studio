/**
 * Built-in skills (bundled under `resources/skills/`) that should ship disabled
 * by default.
 *
 * `SkillService.syncBuiltinSkill` inserts their `agent_global_skill` row with
 * the global gate off, and `AgentGlobalSkillService.list()` defaults them to
 * disabled for every agent. A user can still enable the skill from the skills
 * catalog — once an explicit `agent_skill` preference (or a global toggle)
 * exists, it always wins over the defaults below.
 */
const DEFAULT_DISABLED_BUILTIN_SKILLS: ReadonlySet<string> = new Set(['mechtool-mechanical-design'])

export function isBuiltinSkillDisabledByDefault(folderName: string): boolean {
  return DEFAULT_DISABLED_BUILTIN_SKILLS.has(folderName)
}

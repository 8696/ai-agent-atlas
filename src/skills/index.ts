/**
 * 技能 —— **能力包**（见 [12-c C4](./../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **一个技能 = 一份说明 + 可选脚本** —— 目录在 `data/skills/<name>/`。
 * 📌 **安装 = 拷目录 · 卸载 = 删目录** —— 没有上传界面。
 * 📌 **发现 = 启动时扫描** —— 改完重启才生效。
 */

export {
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  type Skill,
  type SkillMeta,
} from './types.js';

export {
  SkillError,
  createSkill,
  discoverSkills,
  getSkill,
  getSkills,
  isValidScriptPath,
  isValidSkillName,
  readSkill,
  reloadSkills,
  scanSkillContent,
  skillDir,
  skillFilePath,
  syncSkillIndex,
  updateSkill,
  type SkillScanResult,
  type SkillScriptInput,
  type SkillWriteResult,
} from './store.js';

export { matchSkills, type SkillHit } from './match.js';
export { buildSkillSection } from './inject.js';
export {
  runSkillScript,
  skillCreateTool,
  skillScriptTool,
  skillToolGroups,
  skillUpdateTool,
  splitArgs,
} from './tools.js';
export {
  inCooldown,
  resetAutocreateTurns,
  runSkillAutocreate,
  type AutocreateResult,
} from './autocreate.js';

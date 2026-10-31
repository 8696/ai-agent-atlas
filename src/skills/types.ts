import type { ToolSensitivity } from '../tools/types.js';

/**
 * 技能（Skill）的数据结构 —— **对齐 agentskills.io 的开放格式**
 * （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）。
 *
 * 📌 **技能就是「一份说明 + 可选脚本」** ——
 * 目录在 `data/skills/<name>/`，`SKILL.md` 是必需的，其余可选。
 *
 * ⚠️ **安装 = 手动拷目录 · 卸载 = 删目录** —— 没有上传界面。
 */

/** 技能名的合法格式 —— kebab-case */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 技能名长度上限 */
export const SKILL_NAME_MAX_LENGTH = 64;

/** frontmatter 里的元信息 */
export interface SkillMeta {
  /** 技能名 —— **全局唯一**（冲突时启动失败） */
  name: string;
  /** 触发条件描述 —— **给模型看**，它决定这个技能什么时候会被用上 */
  description: string;
  /** 版本（可选） */
  version?: string | undefined;
  /** 是否启用（默认 true —— 停用的不注入上下文） */
  enabled: boolean;
  /** 脚本的敏感档（默认 high —— 技能脚本能执行任意代码） */
  sensitivity: ToolSensitivity;
  /** 自动沉淀的标记 —— **人工编辑过就能去掉** */
  autoCreated: boolean;
  /** 上次「自动更新」的时间（ISO）—— **24 小时内不重复自动更新** */
  autoUpdatedAt?: string | undefined;
}

/** 一个技能 */
export interface Skill {
  /** 元信息 */
  meta: SkillMeta;
  /** `SKILL.md` 正文 —— 给模型看的使用说明 */
  body: string;
  /** 技能目录的绝对路径 */
  dir: string;
  /** `scripts/` 下的脚本（相对技能目录，`/` 分隔） */
  scripts: string[];
  /** `references/` 下的参考资料（相对技能目录，`/` 分隔） */
  references: string[];
}

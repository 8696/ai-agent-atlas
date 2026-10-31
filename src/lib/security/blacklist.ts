/**
 * 命令黑名单 —— **`shell` 工具的兜底防线**（见 [10 §10.6](../../docs/10-安全方案.md)）。
 *
 * ⚠️ **黑名单是兜底不是主防线** —— 主防线是「默认要确认」。
 * 命令黑名单可被绕过（编码、变量展开、别名）→ 所以命中才拦，没命中照样要人确认。
 *
 * 📌 **黑名单可扩展** —— 规则都在下面的数组里。
 */

/** 一条黑名单规则 */
export interface BlacklistRule {
  /** 规则名（**报给模型看，便于它换条路走**） */
  name: string;
  /** 命中原因 */
  reason: string;
  /** 匹配用的正则 */
  pattern: RegExp;
}

/**
 * 黑名单规则表。
 *
 * ⚠️ **故意写得「粗」** —— 黑名单宁可误伤也不可漏放：
 * 命中 `rm -rf /` 的变体（`rm -fr /`、`rm --no-preserve-root -rf /`）也拦。
 */
export const BLACKLIST_RULES: BlacklistRule[] = [
  {
    name: 'rm-rf-root',
    reason: '递归删除根目录',
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(-{1,2}[\w-]+\s+)*\/(?:\s|$|\*)/,
  },
  {
    name: 'rm-rf-home',
    reason: '递归删除家目录',
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(-{1,2}[\w-]+\s+)*(~|\$HOME)(?:\/\s*)?(?:\s|$)/,
  },
  {
    name: 'mkfs',
    reason: '格式化文件系统',
    pattern: /\bmkfs(\.[a-z0-9]+)?\b/,
  },
  {
    name: 'dd-write-device',
    reason: '往设备里写数据',
    pattern: /\bdd\b[^\n]*\bif=/,
  },
  {
    name: 'shutdown',
    reason: '关机 / 重启',
    pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
  },
  {
    name: 'fork-bomb',
    reason: 'fork 炸弹',
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  },
  {
    name: 'curl-pipe-shell',
    reason: '下载内容直接执行',
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/,
  },
  {
    name: 'chmod-777-root',
    reason: '把系统目录改成任何人可写',
    pattern: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/,
  },
  {
    name: 'write-block-device',
    reason: '往块设备写数据',
    pattern: />\s*\/dev\/(sd|nvme|disk|hd)[a-z0-9]*/,
  },
  {
    name: 'history-wipe',
    reason: '清历史（想掩盖痕迹）',
    pattern: /\bhistory\s+-c\b|>\s*~\/\.bash_history|\bunset\s+HISTFILE\b/,
  },
  {
    name: 'iptables-flush',
    reason: '清空防火墙规则',
    pattern: /\biptables\s+(-F|--flush)\b/,
  },
];

/** 命中的黑名单规则（**没命中返回 null**） */
export function matchBlacklist(command: string): BlacklistRule | null {
  const normalized = command.replace(/\s+/g, ' ');
  for (const rule of BLACKLIST_RULES) {
    if (rule.pattern.test(normalized)) return rule;
  }
  return null;
}

/** 命中了就是「直接拒绝」—— 不给确认的机会 */
export function isBlacklisted(command: string): boolean {
  return matchBlacklist(command) !== null;
}

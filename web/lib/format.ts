/**
 * 数字显示 —— **token 与费用的格式化**。
 *
 * 📌 **token 用「缩写 + 精确值」两层** ——
 *    表格里放 `12.3k`（一眼能比大小），悬停 tooltip 给 `12,345`（能对账）。
 *    ⚠️ **不缩写就没法比大小** —— 六位数字挤在一列里，谁多谁少看不出来。
 */

/** 千分位（`12345` → `12,345`） */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

/**
 * token 缩写（`12345` → `12.3k` · `1234567` → `1.23M`）。
 *
 * 📌 **小于 1000 不缩写** —— 那个量级本来就没几位数。
 */
export function formatTokens(value: number): string {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs < 1000) return formatCount(n);
  if (abs < 1_000_000) {
    const k = n / 1000;
    // 📌 **去掉多余的 .0** —— `12.0k` 不如 `12k` 干净
    return `${k.toFixed(k < 10 ? 1 : 0).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(m < 10 ? 2 : 1).replace(/\.0$/, '')}M`;
}

/**
 * 费用（USD）。
 *
 * ⚠️ **0 不等于免费** —— 单价表没配的模型费用只能记 0，
 *    所以这里显示 `$0` 而不是「免费」（见 [12-d D4](../../docs/12-d-需求-记忆与配置.md)）。
 */
export function formatCost(usd: number): string {
  const n = Number(usd) || 0;
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** 用途的中文名（`chat` → `对话`） */
export const SCOPE_LABELS: Record<string, string> = {
  chat: '对话',
  summary: '会话摘要',
  retrieval: '检索摘要',
  memory: '记忆抽取',
  subagent: '子代理',
  cron: '定时任务',
  skill: '技能沉淀',
};

/** 用途的中文名（**没登记的用途就原样显示** —— 别把新用途显示成空白） */
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

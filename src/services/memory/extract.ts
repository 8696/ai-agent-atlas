import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { join } from 'node:path';
import { config } from '../../config.js';
import { DIRS } from '../../config/paths.js';
import { logger } from '../../logger.js';
import { writeAudit } from '../../lib/audit.js';
import { createChatModel, resolveModel } from '../model.js';
import { recordUsage, usageOf } from '../cost.js';
import { readTextFile } from '../prompt.js';
import { scanMemoryWrite } from './scan.js';
import { archiveMemoryEntry, readMemory, upsertMemoryEntry } from './store.js';
import { MEMORY_FILES, type MemoryFile, type MemoryKind } from './types.js';

/**
 * 记忆抽取 —— **T1 正则预筛 + T2 调模型抽取**
 * （见 [12-d D2](../../docs/12-d-需求-记忆与配置.md)）。
 *
 * 📌 **T1 是零成本的闸** —— 大部分对话没有「值得记」的信号，
 * 先用正则挡掉，省一次模型调用。
 * ⚠️ **T2 才是判断** —— 模型看到现有条目后决定**新增 / 改写 / 归档**。
 *
 * ⚠️ **抽取是 fire-and-forget** —— 不阻塞本轮回答；
 * 重复抽取只是多花一次钱，不会写坏数据（写之前会重读）。
 */

/** T1 信号（**中文 + 英文**） */
export const MEMORY_SIGNALS: RegExp[] = [
  /记住|记一下|记下|别忘了|备忘/,
  /我(?:喜欢|不喜欢|讨厌|偏好|习惯|常用|常用的是)/,
  /我叫|我的名字(?:是|叫)|叫我/,
  /(?:我|咱们)(?:一直)?在用|我(?:一直)?用\s*\S+/,
  /以后(?:都|请|别|要)/,
  /每次都|总是会|从来不会/,
  /\bremember\b|\bfrom now on\b|\balways\b|\bnever\b|\bI prefer\b|\bmy name is\b|\bI use\b/i,
];

/** 这一轮有没有「可能值得记」的信号 */
export function hasMemorySignal(text: string): boolean {
  if (!text.trim()) return false;
  return MEMORY_SIGNALS.some((pattern) => pattern.test(text));
}

/** 模型返回的一条操作 */
interface MemoryOp {
  op: 'add' | 'update' | 'archive';
  file: MemoryFile;
  name: string;
  kind?: MemoryKind;
  body?: string;
}

/** 抽取结果 */
export interface ExtractionResult {
  /** 应用了几条 */
  applied: number;
  /** 因为扫描没过被拒了几条 */
  rejected: number;
  /** 原因（**给日志看**） */
  notes: string[];
}

/** 一轮最多应用几条（**别让一次抽取把文件塞满**） */
const MAX_OPS_PER_TURN = 3;

/**
 * 从模型回复里抠出 JSON 数组。
 *
 * ⚠️ **模型经常在 JSON 外面包一段话** —— 所以按「第一个 `[` 到最后一个 `]`」抠。
 */
export function parseOps(text: string): MemoryOp[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ops: MemoryOp[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const op = record['op'];
      const file = record['file'];
      const name = record['name'];
      if (op !== 'add' && op !== 'update' && op !== 'archive') continue;
      if (file !== 'MEMORY' && file !== 'USER') continue;
      if (typeof name !== 'string' || name.trim() === '') continue;
      const kind = record['kind'];
      ops.push({
        op,
        file,
        name: name.trim(),
        ...(typeof kind === 'string' ? { kind: kind as MemoryKind } : {}),
        ...(typeof record['body'] === 'string' ? { body: record['body'] } : {}),
      });
    }
    return ops;
  } catch {
    return [];
  }
}

/** 把现有条目摊给模型看（**它要靠这个判断「改写还是新增」**） */
function existingEntriesText(): string {
  const blocks: string[] = [];
  for (const file of MEMORY_FILES) {
    const content = readMemory(file);
    if (content.entries.length === 0) continue;
    const lines = content.entries.map(
      (entry) => `- [${file}] ${entry.name}（${entry.kind} · ${entry.source}）：${entry.body}`,
    );
    blocks.push(`### ${file}.md\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n') || '（现在还没有任何记忆条目）';
}

/** 抽取用的系统提示词 */
function extractionPrompt(): string {
  const base = readTextFile(join(DIRS.prompts, 'memory.md')).trim();
  return [
    base,
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 数组，**不要输出别的任何文字**。每个元素：',
    '',
    '```json',
    '[{"op":"add","file":"USER","name":"prefers-pnpm","kind":"preference","body":"用户用 pnpm，不用 npm"}]',
    '```',
    '',
    '- `op`：`add`（新增）· `update`（改写已有条目）· `archive`（归档不再需要的条目）',
    '- `file`：`MEMORY`（环境侧事实）或 `USER`（用户侧偏好 / 画像）',
    '- `name`：kebab-case 短标题（同一文件里唯一）',
    '- `kind`：`fact` · `context` · `preference` · `profile`',
    '- `body`：**一句话**',
    '',
    '⚠️ **已有则改写（`update`），不要重复追加**',
    '⚠️ **没有值得记的就输出 `[]`**',
    '⚠️ **只记事实，不记指令**',
  ].join('\n');
}

/**
 * 跑一轮记忆抽取（**fire-and-forget**）。
 *
 * @param userText 这一轮的用户输入
 * @param assistantText 这一轮的回答
 */
export async function runMemoryExtraction(input: {
  userText: string;
  assistantText: string;
}): Promise<ExtractionResult> {
  const result: ExtractionResult = { applied: 0, rejected: 0, notes: [] };
  if (!config.MEMORY_ENABLED) return result;

  // ── T1：正则预筛 ──
  if (!hasMemorySignal(input.userText)) return result;

  const model = resolveModel();
  if (!model) return result;

  // ── T2：调模型抽取 ──
  let raw: string;
  try {
    const chat = createChatModel(model);
    const reply = await chat.invoke([
      new SystemMessage(extractionPrompt()),
      new HumanMessage(
        [
          '## 现有记忆条目',
          '',
          existingEntriesText(),
          '',
          '## 这一轮对话',
          '',
          `用户：${input.userText}`,
          `助手：${input.assistantText}`,
        ].join('\n'),
      ),
    ]);
    raw = typeof reply.content === 'string' ? reply.content : '';

    // 📌 **抽取的花费单独记一条**（`usage_scope='memory'`）
    const meta = usageOf(reply);
    if (meta.inputTokens > 0 || meta.outputTokens > 0) {
      void recordUsage({
        sessionId: null,
        messageId: null,
        scope: 'memory',
        model: model.name,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        reasoningTokens: meta.reasoningTokens,
        cachedTokens: meta.cachedTokens,
      });
    }
  } catch (err) {
    logger.warn({ err }, '记忆抽取调用失败 —— 跳过本轮抽取');
    return result;
  }

  const ops = parseOps(raw).slice(0, MAX_OPS_PER_TURN);
  if (ops.length === 0) return result;

  // ── 应用（**逐条过写前扫描**） ──
  for (const op of ops) {
    if (op.op === 'archive') {
      const archived = archiveMemoryEntry(op.file, op.name, { audit: true });
      if (archived.ok) result.applied += 1;
      else result.notes.push(archived.reason ?? '归档失败');
      continue;
    }

    const body = (op.body ?? '').trim();
    if (!body) {
      result.notes.push(`条目 ${op.name} 没有正文，跳过`);
      continue;
    }

    // ⚠️ **写盘前扫描** —— 记忆是持久化的注入通道，命中就拒绝写
    const scan = scanMemoryWrite(`${op.name}\n${body}`);
    if (!scan.ok) {
      result.rejected += 1;
      result.notes.push(`条目 ${op.name} 被拒：${scan.reasons.join('；')}`);
      void writeAudit('MEMORY_WRITE_REJECTED', 'memory', `${op.file}:${op.name}`, {
        reasons: scan.reasons,
      });
      logger.warn({ name: op.name, reasons: scan.reasons }, '记忆写入被拒绝（写前扫描命中）');
      continue;
    }

    const written = upsertMemoryEntry(
      op.file,
      {
        name: op.name,
        kind: op.kind ?? (op.file === 'USER' ? 'preference' : 'fact'),
        confidence: 0.8,
        source: 'auto',
        updated: '',
        status: 'active',
        body,
      },
      { audit: true },
    );
    if (written.ok) result.applied += 1;
    else result.notes.push(written.reason ?? '写入失败');
  }

  if (result.applied > 0) {
    logger.info({ applied: result.applied, rejected: result.rejected }, '记忆已更新');
  }
  return result;
}

import { QueryTypes } from 'sequelize';
import { sequelize } from '../db.js';
import { expandForTrigram, trigramPhrases } from './text.js';

/**
 * FTS5 全文索引 —— **不用向量**（见 [12-d D3](../docs/12-d-需求-记忆与配置.md)）。
 *
 * ⚠️ **中文分词是硬骨头**：
 * SQLite FTS5 默认 `unicode61` 分词器**不切中文**，
 * 一整句中文会被当成一个 token → 搜「跑一下测试」搜不到「我今天跑了一下单元测试」。
 * → 用 **`tokenize='trigram'`**（SQLite ≥ 3.34 内置，不需要额外编译）。
 *
 * ⚠️ **降级路径**：启动时探测 FTS5 + trigram 是否可用 ——
 * **不可用就退回「时间倒序」**，功能少一半但**不影响对话**。
 */

/** 检索能力 */
export interface FtsCapability {
  /** FTS5 本身可用 */
  available: boolean;
  /** `trigram` 分词器可用（**中文搜索靠它**） */
  trigram: boolean;
  /** 不可用时的原因（**给人看**） */
  reason?: string;
}

/** 一条命中 */
export interface FtsHit {
  /** 命中的内容 */
  content: string;
  /** 所属会话 */
  sessionId: string;
  /** 所属消息 */
  messageId: string;
  /** 相关度（**bm25 分值，越小越相关**） */
  score: number;
}

/** 探测结果（**进程内缓存** —— 探测要建表，不能每轮都做） */
let capability: FtsCapability | undefined;

/**
 * 探测 FTS5 / trigram 可用性。
 *
 * 📌 **用「建一张临时虚表再删掉」来探测** ——
 * 比查 `pragma_compile_options()` 准（有些编译没把 FTS5 写进编译选项）。
 */
export async function probeFts(): Promise<FtsCapability> {
  if (capability) return capability;

  // ── 先试 trigram（**中文搜索靠它**） ──
  try {
    await sequelize.query(
      "CREATE VIRTUAL TABLE temp.__atlas_fts_probe USING fts5(x, tokenize='trigram')",
    );
    await sequelize.query('DROP TABLE temp.__atlas_fts_probe');
    capability = { available: true, trigram: true };
    return capability;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // ── 再试默认分词器（**能搜英文，只是搜不了中文**） ──
    try {
      await sequelize.query('CREATE VIRTUAL TABLE temp.__atlas_fts_probe USING fts5(x)');
      await sequelize.query('DROP TABLE temp.__atlas_fts_probe');
      capability = { available: true, trigram: false, reason: 'trigram 不可用，中文检索会退化' };
      return capability;
    } catch {
      capability = { available: false, trigram: false, reason };
      return capability;
    }
  }
}

/** 测试用：重置探测缓存 */
export function resetFtsProbe(): void {
  capability = undefined;
}

/** 索引表建好了没（**建过一次就不重复建**） */
let tablesEnsured = false;

/** 上次建表失败的时间（**失败别每轮都重试** —— 每轮重试会拖慢每一轮对话） */
let lastEnsureFailure = 0;

/** 失败后多久才重试（毫秒） */
const ENSURE_RETRY_AFTER_MS = 60_000;

/**
 * 建索引表与同步触发器。
 *
 * 📌 **用触发器同步消息表** —— 消息会走 `create` / `update` / `destroy`
 * 好几条路径，触发器是唯一「不会漏」的做法。
 *
 * ⚠️ **`messages_fts` 与 `messages` 用 rowid 对齐** —— 触发器写 `new.rowid`。
 */
export async function ensureFtsTables(force = false): Promise<FtsCapability> {
  const probe = await probeFts();
  if (!probe.available) return probe;
  if (tablesEnsured && !force) return probe;

  // ⚠️ **失败过就先别重试** —— 每轮对话都去建一遍表会把每一轮都拖慢
  if (!force && Date.now() - lastEnsureFailure < ENSURE_RETRY_AFTER_MS) return probe;

  // 📌 **先查在不在** —— 建表是 DDL（要写 schema + fsync），
  //    每轮都建一遍会把每一轮对话都拖慢几百毫秒
  try {
    const rows = await sequelize.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('trigger','table') AND (name LIKE 'messages_fts_%' OR name = 'skills_fts')",
      { type: QueryTypes.SELECT },
    );
    // ⚠️ **3 个消息触发器 + 1 张技能表** —— 缺一个就往下走重建
    const triggers = rows.filter((row) => row.name.startsWith('messages_fts_')).length;
    const hasSkills = rows.some((row) => row.name === 'skills_fts');
    if (triggers >= 3 && hasSkills) {
      tablesEnsured = true;
      return probe;
    }
  } catch {
    // 查不到就当没有 —— 下面照常建
  }

  const tokenizer = probe.trigram ? "tokenize='trigram'" : '';
  try {
    await sequelize.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, session_id UNINDEXED, ${tokenizer})`,
    );
    await sequelize.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(name, body, file UNINDEXED, ${tokenizer})`,
    );
    // 📌 **技能表多一列 `bigrams`** —— 二元组展开后的形式，
    //    让「周报」这种 2 字中文词也能被 trigram 搜到
    //    （见 [12-c C4](../docs/12-c-需求-工具技能与扩展.md)）
    await sequelize.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(name, description, body, bigrams, ${tokenizer})`,
    );

    await sequelize.query(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, session_id) VALUES (new.rowid, new.content, new.session_id);
      END
    `);
    await sequelize.query(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END
    `);
    await sequelize.query(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, content, session_id) VALUES (new.rowid, new.content, new.session_id);
      END
    `);
  } catch (err) {
    lastEnsureFailure = Date.now();
    throw err;
  }

  tablesEnsured = true;
  return probe;
}

/**
 * 英文停用词（**太常见，当关键词没意义** —— 「the」当关键词会把一堆消息都捞出来）。
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'all', 'any', 'can',
  'did', 'does', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'was',
  'were', 'been', 'being', 'have', 'has', 'had', 'with', 'from', 'into', 'that',
  'this', 'these', 'those', 'there', 'then', 'than', 'them', 'they', 'its',
  'our', 'out', 'off', 'over', 'under', 'again', 'just', 'like', 'about',
  'would', 'could', 'should', 'will', 'shall', 'may', 'might', 'must', 'get',
  'got', 'had', 'him', 'her', 'his', 'she', 'his', 'too', 'very', 'also',
]);

/** 一个查询最多拆几个词（**FTS5 的 OR 串别太长**） */
const MAX_TERMS = 32;

/**
 * 把用户输入拆成**能命中**的词。
 *
 * ⚠️ **不能整句包成短语** —— 用户问的是自然语言
 * （「我上次是怎么配那个数据库的」），整句在历史消息里**根本不是连续子串**，
 * 命中不了（这是 D3 验收项里那句例子的真实行为）。
 *
 * 📌 **规则**：
 * - **中文**：切连续汉字串 → **3 字滑窗**（trigram 至少要 3 个字符才能匹配）
 *   ⚠️ 3 字窗是**子串**，所以「数据库」能命中「数据库换成了 Postgres」
 * - **英文 / 数字**：整词留下（≥ 4 字符，且不是停用词）
 */
export function expandQueryTerms(text: string): string[] {
  const terms: string[] = [];
  const chunks = text
    .toLowerCase()
    .split(/[^\p{Script=Han}a-z0-9_]+/u)
    .filter((chunk) => chunk !== '');

  for (const chunk of chunks) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      // ⚠️ **不足 3 字匹配不到** —— 丢掉
      if (chunk.length < 3) continue;
      if (chunk.length === 3) {
        terms.push(chunk);
        continue;
      }
      for (let i = 0; i + 3 <= chunk.length; i += 1) terms.push(chunk.slice(i, i + 3));
      continue;
    }
    if (chunk.length >= 4 && !STOPWORDS.has(chunk)) terms.push(chunk);
  }

  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/**
 * 把查询词变成 FTS5 的 **MATCH 串**。
 *
 * ⚠️ **每个词都包引号** —— 用户输入里可能有 `-` `*` `:` 等 FTS5 语法字符，
 * 不包的话会直接报语法错（`fts5: syntax error`）。
 * ⚠️ **多个词用 OR 连起来** —— 整句包成短语的话自然语言问题永远命中不了。
 * ⚠️ **trigram 要求查询词 ≥ 3 字符** —— 太短直接不查（交给降级路径）。
 */
export function toMatchQuery(text: string): string | null {
  const terms = expandQueryTerms(text);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** 查会话内容 */
export async function searchMessages(query: string, limit: number): Promise<FtsHit[]> {
  const probe = await probeFts();
  if (!probe.available) return [];
  const match = toMatchQuery(query);
  if (!match) return [];

  const rows = await sequelize.query<{
    content: string;
    session_id: string;
    id: string;
    score: number;
  }>(
    `SELECT m.content AS content, m.session_id AS session_id, m.id AS id,
            bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH :match
      ORDER BY score
      LIMIT :limit`,
    { replacements: { match, limit }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => ({
    content: row.content,
    sessionId: row.session_id,
    messageId: row.id,
    score: row.score,
  }));
}

/** 查记忆条目（**记忆在文件里 —— 索引由写入时重建**） */
export async function searchMemory(
  query: string,
  limit: number,
): Promise<Array<{ name: string; body: string; file: string; score: number }>> {
  const probe = await probeFts();
  if (!probe.available) return [];
  const match = toMatchQuery(query);
  if (!match) return [];

  const rows = await sequelize.query<{ name: string; body: string; file: string; score: number }>(
    `SELECT name, body, file, bm25(memory_fts) AS score
       FROM memory_fts
      WHERE memory_fts MATCH :match
      ORDER BY score
      LIMIT :limit`,
    { replacements: { match, limit }, type: QueryTypes.SELECT },
  );
  return rows;
}

/** 重建记忆索引（**记忆在文件里，改了文件就要重建**） */
export async function reindexMemory(
  entries: Array<{ file: string; name: string; body: string }>,
): Promise<void> {
  const probe = await probeFts();
  if (!probe.available) return;
  await sequelize.query('DELETE FROM memory_fts');
  for (const entry of entries) {
    await sequelize.query('INSERT INTO memory_fts(name, body, file) VALUES (:name, :body, :file)', {
      replacements: { name: entry.name, body: entry.body, file: entry.file },
    });
  }
}

/**
 * 把查询包成技能检索用的 FTS5 表达式（**多个短语 OR 起来**）。
 *
 * 📌 **短语来自二元组展开** —— 每个短语后面都带一个空格，
 * 这样「周报」（2 字）也能切出 trigram（见 `lib/text.ts` 的 `trigramPhrases`）。
 *
 * ⚠️ **每个短语都要转义引号** —— 用户输入里可能有 `"` 等 FTS5 语法字符。
 */
export function toSkillMatchQuery(text: string): string | null {
  const phrases = trigramPhrases(text);
  if (phrases.length === 0) return null;
  return phrases
    .map((phrase) => `"${phrase.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** 查技能（**按 bm25 排序 —— 越小越相关**） */
export async function searchSkills(
  query: string,
  limit: number,
): Promise<Array<{ name: string; score: number }>> {
  const probe = await probeFts();
  if (!probe.available) return [];
  const match = toSkillMatchQuery(query);
  if (!match) return [];

  const rows = await sequelize.query<{ name: string; score: number }>(
    `SELECT name, bm25(skills_fts) AS score
       FROM skills_fts
      WHERE skills_fts MATCH :match
      ORDER BY score
      LIMIT :limit`,
    { replacements: { match, limit }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => ({ name: row.name, score: row.score }));
}

/** 重建技能索引（**技能在文件里，改了文件就要重建**） */
export async function reindexSkills(
  entries: Array<{ name: string; description: string; body: string }>,
): Promise<void> {
  const probe = await probeFts();
  if (!probe.available) return;
  await sequelize.query('DELETE FROM skills_fts');
  for (const entry of entries) {
    await sequelize.query(
      `INSERT INTO skills_fts(name, description, body, bigrams)
       VALUES (:name, :description, :body, :bigrams)`,
      {
        replacements: {
          name: entry.name,
          description: entry.description,
          body: entry.body,
          // 📌 **索引侧与查询侧用同一个展开函数** —— 两边不一致就永远对不上
          bigrams: expandForTrigram(`${entry.name} ${entry.description} ${entry.body}`),
        },
      },
    );
  }
}

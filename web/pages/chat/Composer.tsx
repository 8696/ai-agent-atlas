import { useEffect, useMemo, useState } from 'react';
import { Button, Input } from 'antd';
import { ArrowUpOutlined, StopOutlined } from '@ant-design/icons';
import { fetchCommands, type CommandInfo } from '../../lib/api';
import { useModelStore } from '../../lib/stores/modelStore';

/**
 * 输入区（见 [04-b §4.1.2](../docs/04-b-ui-聊天页.md)）。
 *
 * | 元素   | 规格                                       |
 * | ------ | ------------------------------------------ |
 * | 输入框 | 多行，`Enter` 发送 · `Shift+Enter` 换行     |
 * | 发送   | 空内容时禁用；发送中变成「停止」            |
 * | 停止   | 调 `chat.stop()`；已输出的内容保留          |
 *
 * 📌 **斜杠命令补全**（见 [12-b B9](../../docs/12-b-需求-对话与编排.md)）：
 * 输入 `/` 弹候选（命令 + 人格 + 模型），
 * `Tab` 补全 · `↑↓` 选择 · `Esc` 关闭。
 * ⚠️ **只是补全** —— 命令在服务端解析，前端不执行。
 * ⚠️ **技能不进候选** —— 技能是 FTS5 匹配进上下文的，不是斜杠命令。
 */

interface Props {
  /** 后端没配模型 / 请求进行中 —— 决定按钮形态 */
  busy: boolean;
  /** 整体禁用（比如没配模型） */
  disabled?: boolean;
  onSubmit: (text: string) => void;
  onStop: () => void;
}

/** 一条候选 */
interface Candidate {
  /** 补全后填进去的文本 */
  value: string;
  /** 展示名 */
  label: string;
  /** 右侧的说明 */
  hint: string;
}

export function Composer({ busy, disabled = false, onSubmit, onStop }: Props) {
  const [value, setValue] = useState('');
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [personalities, setPersonalities] = useState<string[]>([]);
  /** 当前选中的候选项下标（**-1 = 没开列表**） */
  const [active, setActive] = useState(-1);
  /** 候选列表被 Esc 关掉了（**改输入才重开**） */
  const [dismissed, setDismissed] = useState(false);

  // 📌 **模型名也在候选里**（`/model <名称>` 切换本会话的模型）
  const models = useModelStore((state) => state.models);

  useEffect(() => {
    void fetchCommands()
      .then((data) => {
        setCommands(data.commands);
        // 📌 **技能不进候选** —— 服务端没有 `/技能名` 这个命令，
        //    补出来发出去只会被回一句「未知命令」
        setPersonalities(data.personalities);
      })
      .catch(() => {
        // ⚠️ **拉不到就不补全** —— 不影响正常输入
      });
  }, []);

  const canSend = !disabled && value.trim().length > 0;

  /**
   * 当前正在输入的命令（**行首是 `/` 才算**）。
   *
   * 📌 **命令名与参数分开看** ——
   * `/model g` 要能补出 `/model glm`，
   * 所以拿**命令名**去筛命令、拿**参数**去筛参数。
   */
  const trimmed = value.trim();
  const spaceAt = trimmed.indexOf(' ');
  const commandPart = (spaceAt >= 0 ? trimmed.slice(0, spaceAt) : trimmed).toLowerCase();
  const argPart = spaceAt >= 0 ? trimmed.slice(spaceAt + 1).trim().toLowerCase() : '';

  /** 候选列表 */
  const candidates = useMemo<Candidate[]>(() => {
    if (!commandPart.startsWith('/')) return [];
    const out: Candidate[] = [];

    // ── 命令名 ──
    for (const command of commands) {
      const item = `/${command.name}`;
      if (!item.toLowerCase().startsWith(commandPart)) continue;
      out.push({ value: `${item} `, label: item, hint: command.summary });
    }

    // ── `/personality <文件名>` ──
    if (commandPart === '/personality') {
      for (const personality of personalities) {
        if (!personality.toLowerCase().startsWith(argPart)) continue;
        out.push({
          value: `/personality ${personality}`,
          label: personality,
          hint: '人格',
        });
      }
    }

    // ── `/model <名称>` ──
    if (commandPart === '/model') {
      for (const model of models) {
        if (!model.name.toLowerCase().startsWith(argPart)) continue;
        out.push({ value: `/model ${model.name}`, label: model.name, hint: '模型' });
      }
    }

    return out.slice(0, 12);
  }, [commandPart, argPart, commands, personalities, models]);

  // 📌 **Esc 关掉列表** —— 关了之后输入不变就一直关着（再改输入才重开）
  const open = candidates.length > 0 && !dismissed;

  /** 选中某个候选 → 替换输入框里的内容 */
  const applyCandidate = (candidate: Candidate) => {
    setValue(candidate.value);
    setActive(-1);
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    setActive(-1);
    onSubmit(text);
  };

  return (
    <div className="atlas-composer">
      {open ? (
        <div className="atlas-cmd-list" role="listbox" aria-label="命令补全">
          {candidates.map((candidate, index) => (
            <button
              key={candidate.value}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`atlas-cmd-item${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => applyCandidate(candidate)}
            >
              <span className="atlas-cmd-label">{candidate.label}</span>
              <span className="atlas-cmd-hint">{candidate.hint}</span>
            </button>
          ))}
        </div>
      ) : null}

      <Input.TextArea
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setActive(-1);
          // 📌 **改了输入就重新弹列表** —— Esc 关掉之后接着打字应该能再看到
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          // 📌 **上下键选候选** —— 只在列表开着时接管
          if (open && event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => (index + 1) % candidates.length);
            return;
          }
          if (open && event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => (index <= 0 ? candidates.length - 1 : index - 1));
            return;
          }
          if (open && event.key === 'Escape') {
            event.preventDefault();
            // 📌 **Esc 关掉整个列表** —— 以前只清高亮，列表还挂在输入框上方
            setActive(-1);
            setDismissed(true);
            return;
          }
          // ⚠️ **Tab 用来补全** —— 开着列表时不让它跳焦点
          if (open && event.key === 'Tab') {
            event.preventDefault();
            const candidate = candidates[active >= 0 ? active : 0];
            if (candidate) applyCandidate(candidate);
            return;
          }
          // ⚠️ **Shift+Enter 换行** —— 不拦截
          if (event.shiftKey) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={disabled ? '先在 .env 里配置 LLM_MODEL' : '说点什么… 输入 / 看命令'}
        autoSize={{ minRows: 3, maxRows: 8 }}
        disabled={disabled}
        variant="borderless"
        aria-label="输入消息"
      />
      <div className="atlas-composer-actions">
        {busy ? (
          <Button
            type="text"
            size="small"
            icon={<StopOutlined />}
            onClick={onStop}
            aria-label="停止"
          />
        ) : (
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={!canSend}
            onClick={submit}
            aria-label="发送"
          />
        )}
      </div>
    </div>
  );
}

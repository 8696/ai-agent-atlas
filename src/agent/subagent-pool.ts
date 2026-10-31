/**
 * 子代理的并发闸 —— **超过上限就排队，不报错**
 * （见 [12-b B10](./docs/12-b-需求-对话与编排.md)）。
 *
 * ⚠️ **排队而不是拒绝** —— 主 Agent 想派 5 个子代理，
 *    上限是 3，那就先跑 3 个、后面 2 个排队。
 */

/** 一个计数信号量 */
export class Semaphore {
  private limit: number;
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** 拿一个名额（**满了就排队**） */
  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  /** 还一个名额（**顺便叫醒排队的**） */
  release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.waiting.shift();
    if (next) next();
  }

  /** 现在跑着几个 */
  get activeCount(): number {
    return this.running;
  }

  /** 排着几个 */
  get queuedCount(): number {
    return this.waiting.length;
  }

  /** 上限 */
  get capacity(): number {
    return this.limit;
  }
}

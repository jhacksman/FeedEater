import type { Request, Response } from "express";

interface SubjectData {
  module: string;
  publishTimes: number[];
  totalPublished: number;
  lastPublishedAt: number;
  consumerCount: number;
}

export class QueueStatsStore {
  private subjects = new Map<string, SubjectData>();
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.nowFn = nowFn ?? (() => Date.now());
  }

  recordPublish(subject: string, module: string): void {
    const now = this.nowFn();
    let data = this.subjects.get(subject);
    if (!data) {
      data = {
        module,
        publishTimes: [],
        totalPublished: 0,
        lastPublishedAt: now,
        consumerCount: 0,
      };
      this.subjects.set(subject, data);
    }
    data.totalPublished += 1;
    data.publishTimes.push(now);
    data.lastPublishedAt = now;
    if (data.publishTimes.length > 1000) data.publishTimes.shift();
  }

  setConsumerCount(subject: string, count: number): void {
    const data = this.subjects.get(subject);
    if (data) {
      data.consumerCount = count;
    }
  }

  getSubjects(): string[] {
    return [...this.subjects.keys()];
  }

  getData(subject: string): SubjectData | undefined {
    return this.subjects.get(subject);
  }
}

interface QueuesDeps {
  queueStore: QueueStatsStore;
  nowFn?: () => number;
}

export function getSystemQueues({ queueStore, nowFn }: QueuesDeps) {
  return (_req: Request, res: Response): void => {
    const now = nowFn?.() ?? Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;

    const subjects = queueStore.getSubjects();
    const queues: Array<{
      subject: string;
      module: string;
      messages_published: number;
      rate_per_sec: number;
      last_published_at: string;
      consumer_count: number;
    }> = [];

    let totalRate = 0;

    for (const subject of subjects) {
      const data = queueStore.getData(subject);
      if (!data) continue;

      const recentCount = data.publishTimes.filter((t) => t >= cutoff).length;
      const ratePerSec = +(recentCount / 60).toFixed(4);
      totalRate += ratePerSec;

      queues.push({
        subject,
        module: data.module,
        messages_published: data.totalPublished,
        rate_per_sec: ratePerSec,
        last_published_at: new Date(data.lastPublishedAt).toISOString(),
        consumer_count: data.consumerCount,
      });
    }

    queues.sort((a, b) => a.subject.localeCompare(b.subject));

    res.json({
      queues,
      total_subjects: queues.length,
      total_rate: +totalRate.toFixed(4),
      timestamp: new Date(now).toISOString(),
    });
  };
}

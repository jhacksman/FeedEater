import type { Request, Response } from "express";

interface SubjectStats {
  publish_count: number;
  last_published_at: string | null;
}

export class NatsHealthStore {
  private connected = false;
  private serverUrl: string | null = null;
  private clientId: string | null = null;
  private subscriptionsCount = 0;
  private messagesPublishedTotal = 0;
  private messagesReceivedTotal = 0;
  private lastConnectedAt: string | null = null;
  private reconnectCount = 0;
  private subjects = new Map<string, SubjectStats>();

  setConnected(connected: boolean, timestamp?: string): void {
    this.connected = connected;
    if (connected) {
      this.lastConnectedAt = timestamp ?? new Date().toISOString();
    }
  }

  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  setClientId(id: string): void {
    this.clientId = id;
  }

  setSubscriptionsCount(count: number): void {
    this.subscriptionsCount = count;
  }

  recordPublish(subject: string, timestamp?: string): void {
    this.messagesPublishedTotal += 1;
    const ts = timestamp ?? new Date().toISOString();
    let stats = this.subjects.get(subject);
    if (!stats) {
      stats = { publish_count: 0, last_published_at: null };
      this.subjects.set(subject, stats);
    }
    stats.publish_count += 1;
    stats.last_published_at = ts;
  }

  recordReceive(): void {
    this.messagesReceivedTotal += 1;
  }

  recordReconnect(timestamp?: string): void {
    this.reconnectCount += 1;
    this.connected = true;
    this.lastConnectedAt = timestamp ?? new Date().toISOString();
  }

  getState() {
    const subjects: Record<string, SubjectStats> = {};
    for (const [subject, stats] of this.subjects) {
      subjects[subject] = { ...stats };
    }
    return {
      connected: this.connected,
      server_url: this.serverUrl,
      client_id: this.clientId,
      subscriptions_count: this.subscriptionsCount,
      messages_published_total: this.messagesPublishedTotal,
      messages_received_total: this.messagesReceivedTotal,
      last_connected_at: this.lastConnectedAt,
      reconnect_count: this.reconnectCount,
      subjects,
    };
  }

  clear(): void {
    this.connected = false;
    this.serverUrl = null;
    this.clientId = null;
    this.subscriptionsCount = 0;
    this.messagesPublishedTotal = 0;
    this.messagesReceivedTotal = 0;
    this.lastConnectedAt = null;
    this.reconnectCount = 0;
    this.subjects.clear();
  }
}

interface NatsHealthDeps {
  natsHealthStore: NatsHealthStore;
  nowFn?: () => number;
}

export function getSystemNatsHealth({ natsHealthStore, nowFn }: NatsHealthDeps) {
  return (_req: Request, res: Response): void => {
    const now = nowFn?.() ?? Date.now();
    const state = natsHealthStore.getState();

    res.json({
      ...state,
      checked_at: new Date(now).toISOString(),
    });
  };
}

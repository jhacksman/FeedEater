import { NatsConnection } from 'nats';
import { PrismaClient } from '@prisma/client';
import WebSocket from 'ws';

// Import FeedEater event and utility types
import { NormalizedTradeExecuted } from '../../../types/NormalizedMessages';
import { BitfinexSettings, parseBitfinexSettingsFromInternal } from '../settings';

export type BitfinexSettings = {
  enabled: boolean;
  apiUrl: string;
  whaleThreshold: number;
  watchedPairs: string[];
};

export function parseBitfinexSettingsFromInternal(
  internal: any,
): BitfinexSettings {
  return {
    enabled: internal.enabled ?? true,
    apiUrl: internal.apiUrl ?? 'wss://api-pub.bitfinex.com/ws/2',
    whaleThreshold: internal.whaleThreshold ?? 50000,
    watchedPairs: internal.watchedPairs ?? ['tBTCUSD', 'tETHUSD', 'tSOLUSD'],
  };
}

export interface BitfinexIngestorOptions {
  settings: BitfinexSettings;
  nats: NatsConnection;
  db: PrismaClient;
  logger: any;
}

// Bitfinex v2 WebSocket uses array-formatted trade events (not JSON objects)
interface BitfinexTradeMessage {
  // channelId: number;
  data: any[];
}

export class BitfinexIngestor {
  ws: WebSocket;
  private heartbeatInterval: NodeJS.Timeout | undefined;
  opts: BitfinexIngestorOptions;
  running = false;

  constructor(opts: BitfinexIngestorOptions) {
    this.opts = opts;
    this.ws = new WebSocket(this.opts.settings.apiUrl);
    this.setupSocket();
  }

  setupSocket() {
    this.ws.on('open', () => {
      this.subscribeToPairs();
      this.running = true;
      this.opts.logger?.info('Bitfinex WS connected');
    });
    this.ws.on('message', (msg) => this.handleMessage(msg));
    this.ws.on('close', () => { this.running = false; this.reconnect(); });
    this.ws.on('error', (err) => { this.opts.logger?.error(`Bitfinex WS error: ${err}`); this.reconnect(); });
  }

  subscribeToPairs() {
    for (const symbol of this.opts.settings.watchedPairs) {
      this.ws.send(JSON.stringify({
        event: 'subscribe',
        channel: 'trades',
        symbol,
      }));
    }
  }

  reconnect() {
    setTimeout(() => {
      this.ws = new WebSocket(this.opts.settings.apiUrl);
      this.setupSocket();
    }, 1000);
  }

  handleMessage(raw: WebSocket.RawData) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) { return; }
    // Event handling
    if (msg.event === 'info' || msg.event === 'subscribed' || msg.event === 'pong') { return; }
    if (msg.event === 'error') {
      this.opts.logger?.error('Bitfinex error', msg);
      return;
    }
    if (Array.isArray(msg) && typeof msg[1] === 'string' && msg[1] === 'hb') {
      // Heartbeat message
      this.opts.logger?.debug('Bitfinex WS heartbeat');
      return;
    }
    // Trade events
    if (Array.isArray(msg) && msg[1] === 'tu') {
      // Trade update
      const tradeArr = msg[2];
      const event = this.mapTrade(tradeArr, msg);
      if (event) this.processTradeExecuted(event);
    }
  }

  mapTrade(tradeArr: any, msg: any): NormalizedTradeExecuted | null {
    // Docs: [ID, MTS, AMOUNT, PRICE]
    if (!Array.isArray(tradeArr) || tradeArr.length < 4) return null;
    const [id, mts, amount, price] = tradeArr;
    const symbol = msg[3]?.symbol || 'UNKNOWN'; // Not always present, try msg context
    // Only subscribe to allowed pairs, but safety filter
    if (!this.opts.settings.watchedPairs.includes(symbol)) return null;
    const side = amount > 0 ? 'buy' : 'sell';
    const size = Math.abs(amount);
    const usdValue = Math.abs(price * size);
    const whale = usdValue >= this.opts.settings.whaleThreshold;
    return {
      id: `bitfinex-${symbol}-${id}`,
      exchange: 'bitfinex',
      pair: symbol.replace(/^t/, ''),
      timestamp: mts,
      size,
      price,
      side,
      usdValue,
      tags: whale ? ['whale'] : [],
    };
  }

  async processTradeExecuted(event: NormalizedTradeExecuted) {
    // Publish to NATS and persist in DB using binance/polymarket patterns
    await this.opts.nats.publish('feedeater.bitfinex.tradeExecuted', JSON.stringify(event));
    try {
      await this.opts.db.dex_swaps.create({
        data: {
          chain: 'ethereum',
          dex: 'bitfinex',
          pair: event.pair,
          tx_hash: event.id,
          block: null,
          timestamp_ms: event.timestamp,
          token0_amount: event.size,
          token1_amount: null,
          usd_value: event.usdValue,
          sender: null,
          is_whale: !!event.tags.includes('whale'),
        },
      });
    } catch (err) {
      this.opts.logger?.warn('Bitfinex DB error:', err);
    }
  }
}

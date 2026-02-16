import { BitfinexIngestor, parseBitfinexSettingsFromInternal } from '../ingest';
import { createModuleRuntime } from '../runtime';
import { NormalizedTradeExecuted } from '../../../types/NormalizedMessages';

describe('Bitfinex Integration', () => {
  it('should normalize and store a tradeExecuted event with whale tag if >$50K', async () => {
    const settings = parseBitfinexSettingsFromInternal({ watchedPairs: ['tBTCUSD'], whaleThreshold: 50000 });
    const fakeNats = { publish: jest.fn() };
    const fakeDb = { dex_swaps: { create: jest.fn() } };
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const ingestor = new BitfinexIngestor({ settings, nats: fakeNats, db: fakeDb, logger });
    // Simulate a whale trade
    const tradeArr = ["1890740203", Date.now(), 1.1, 63000];
    const msg = [0, 'tu', tradeArr, { symbol: 'tBTCUSD' }];
    const event = ingestor.mapTrade(tradeArr, msg);
    expect(event).not.toBeNull();
    expect(event!.tags).toContain('whale');
    await ingestor.processTradeExecuted(event!);
    expect(fakeNats.publish).toHaveBeenCalledWith(expect.stringContaining('feedeater.bitfinex.tradeExecuted'), expect.stringContaining('tBTCUSD'));
    expect(fakeDb.dex_swaps.create).toHaveBeenCalled();
  });
});

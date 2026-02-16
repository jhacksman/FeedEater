import { BitfinexIngestor, parseBitfinexSettingsFromInternal } from '../ingest';
import { createModuleRuntime } from '../runtime';

describe('Bitfinex public feed connectivity', () => {
  it('should ingest trade data for tBTCUSD without error', async () => {
    const settings = parseBitfinexSettingsFromInternal({ watchedPairs: ['tBTCUSD'] });
    const fakeNats = { publish: jest.fn() };
    const fakeDb = { dex_swaps: { create: jest.fn() } };
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const ingestor = new BitfinexIngestor({ settings, nats: fakeNats, db: fakeDb, logger });
    // Wait up to 4 seconds for at least 1 trade
    for (let i = 0; i < 40; i++) {
      if (fakeNats.publish.mock.calls.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(fakeNats.publish.mock.calls.length).toBeGreaterThan(0); // At least one trade fires
  });
});

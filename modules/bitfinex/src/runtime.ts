import { createModuleRuntime as baseCreateModuleRuntime } from '../../module-runtime';
import { BitfinexIngestor, parseBitfinexSettingsFromInternal } from './ingest';

export function createModuleRuntime(moduleInternalSettings: any, ctx: any) {
  return baseCreateModuleRuntime({
    moduleInternalSettings,
    ctx,
    Ingestor: BitfinexIngestor,
    parseSettings: parseBitfinexSettingsFromInternal,
    ingestName: 'BitfinexIngestor',
  });
}

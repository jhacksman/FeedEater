export { AromerStrategy, parseAromerSettings } from "./strategy.js";
export type {
  AromerStrategySettings,
  Signal,
  PaperOrder,
  Position,
  PerformanceMetrics,
  VenueEdge,
} from "./strategy.js";

export { paperTrade, reportMetrics, backtest } from "./runtime.js";

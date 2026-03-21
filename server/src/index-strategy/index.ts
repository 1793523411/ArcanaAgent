export type { StrategyType, IndexStatus, SearchResult, SearchOptions, IndexStrategy } from "./types.js";
export { NoneStrategy } from "./strategies/none.js";
export { detectAvailableStrategies, type DetectionResult, type StrategyAvailability } from "./detect.js";
export { indexManager } from "./manager.js";

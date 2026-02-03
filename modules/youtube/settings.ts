/**
 * YouTube Module Settings
 * 
 * These types mirror the settings schema defined in module.json.
 * Secrets are encrypted at rest and only decrypted when fetched via the internal API.
 */

export type CollectionStrategy = 'rss' | 'api' | 'hybrid';

export interface YouTubeSettings {
  /** Enable/disable the module */
  enabled: boolean;
  
  /** Collection strategy: rss (0 quota), api (rich data), or hybrid (best of both) */
  collectionStrategy: CollectionStrategy;
  
  /** Comma-separated list of channel IDs to monitor (manual specification) */
  channelIds: string;
  
  /** Auto-fetch subscribed channels via OAuth (requires API strategy) */
  syncSubscriptions: boolean;
  
  /** Maximum videos to fetch per channel (RSS max is ~15) */
  maxVideosPerChannel: number;
  
  /** How far back to fetch videos (days) */
  lookbackDays: number;
  
  /** Fetch full video metadata via API (costs quota) */
  fetchVideoDetails: boolean;
  
  /** Include YouTube Shorts in the feed */
  includeShorts: boolean;
  
  /** Exclude live streams from the feed */
  excludeLiveStreams: boolean;
  
  /** How often to check for new videos (minutes) */
  checkIntervalMinutes: number;
}

export interface YouTubeSecrets {
  /** OAuth 2.0 credentials JSON (from Google Cloud Console) */
  oauthCredentials: string | null;
  
  /** OAuth refresh token (auto-populated after authorization) */
  refreshToken: string | null;
  
  /** API key for public data only (alternative to OAuth for read-only) */
  apiKey: string | null;
}

/** Default settings values */
export const defaultSettings: YouTubeSettings = {
  enabled: true,
  collectionStrategy: 'rss',
  channelIds: '',
  syncSubscriptions: false,
  maxVideosPerChannel: 15,
  lookbackDays: 7,
  fetchVideoDetails: false,
  includeShorts: true,
  excludeLiveStreams: false,
  checkIntervalMinutes: 60,
};

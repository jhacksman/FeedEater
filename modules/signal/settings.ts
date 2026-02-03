/**
 * Signal Module Settings
 * 
 * NOTE: Signal is E2E encrypted. There is NO server API.
 * signal-cli acts as a linked device - only receives messages AFTER linking.
 * Historical message access is cryptographically impossible.
 */

export interface SignalSettings {
  /**
   * Phone number in international E.164 format (+CountryCodeNumber)
   * This is the Signal account signal-cli is linked to.
   * Example: "+15551234567"
   */
  phoneNumber: string;

  /**
   * Connection mode for signal-cli daemon
   * - "socket": Unix socket connection (recommended for local deployments)
   * - "jsonrpc": HTTP JSON-RPC connection (better for Docker/remote)
   */
  connectionMode: 'socket' | 'jsonrpc';

  /**
   * Unix socket path when connectionMode is "socket"
   * Default: /var/run/signal-cli/socket
   */
  daemonSocket?: string;

  /**
   * JSON-RPC URL when connectionMode is "jsonrpc"
   * Default: http://localhost:7583
   */
  daemonRpcUrl?: string;

  /**
   * Collect messages from group conversations
   * Default: true
   */
  collectGroups: boolean;

  /**
   * Collect messages from 1:1 private conversations
   * Default: true
   */
  collectPrivate: boolean;

  /**
   * Track reactions (emoji responses) to messages
   * Default: true
   */
  collectReactions: boolean;

  /**
   * Capture messages with disappearing timers
   * ETHICAL NOTE: Senders chose disappearing for privacy reasons.
   * When true: Message content is persisted in FeedEater despite timer
   * When false: Disappearing messages are noted but content not stored
   * Default: true (but consider your use case)
   */
  handleDisappearing: boolean;

  /**
   * Persist view-once media content
   * ETHICAL NOTE: View-once is explicitly meant to not be saved.
   * Strongly recommend leaving false.
   * Default: false
   */
  persistViewOnce: boolean;

  /**
   * Automatically trust contacts when their safety number changes
   * Security trade-off: 
   * - true: Seamless but vulnerable to MITM
   * - false: Requires manual trust, more secure
   * Default: false
   */
  trustAllIdentities: boolean;

  /**
   * Polling interval in milliseconds for daemon receive calls
   * Lower = more responsive but more overhead
   * Default: 5000 (5 seconds)
   */
  pollIntervalMs: number;

  /**
   * How often to verify session health (hours)
   * Checks if linked device is still active
   * Default: 24
   */
  sessionCheckIntervalHours: number;

  /**
   * Phone numbers to explicitly include (whitelist)
   * If set, ONLY messages from these numbers are collected
   * Empty array means collect from everyone
   * Format: E.164 (+15551234567)
   */
  includeContacts: string[];

  /**
   * Phone numbers to exclude (blacklist)
   * Messages from these numbers are never collected
   * Format: E.164 (+15551234567)
   */
  excludeContacts: string[];

  /**
   * Group IDs to explicitly include (whitelist)
   * If set, ONLY messages from these groups are collected
   * Empty array means collect from all groups
   */
  includeGroups: string[];

  /**
   * Group IDs to exclude (blacklist)
   * Messages from these groups are never collected
   */
  excludeGroups: string[];

  /**
   * Minimum message length to collect (characters)
   * Useful to skip very short messages like "ok" or "👍"
   * Default: 0 (collect all)
   */
  minMessageLength: number;

  /**
   * Download and store attachments
   * Default: false (only store metadata)
   */
  downloadAttachments: boolean;

  /**
   * Maximum attachment size to download (bytes)
   * Default: 10485760 (10MB)
   */
  maxAttachmentSize: number;
}

/**
 * Signal Module Secrets
 * These are encrypted at rest and never returned from public API
 */
export interface SignalSecrets {
  // No secrets needed for signal-cli integration
  // signal-cli manages its own session data in filesystem
  // 
  // Note: signal-cli's session data (~/.local/share/signal-cli/data/)
  // is the real "secret" - it provides full account access
  // This should be protected at the filesystem level
}

/**
 * Default settings for Signal module
 */
export const defaultSignalSettings: SignalSettings = {
  phoneNumber: '',
  connectionMode: 'jsonrpc',
  daemonSocket: '/var/run/signal-cli/socket',
  daemonRpcUrl: 'http://localhost:7583',
  collectGroups: true,
  collectPrivate: true,
  collectReactions: true,
  handleDisappearing: true,
  persistViewOnce: false,  // Respect sender intent by default
  trustAllIdentities: false,  // Secure by default
  pollIntervalMs: 5000,
  sessionCheckIntervalHours: 24,
  includeContacts: [],
  excludeContacts: [],
  includeGroups: [],
  excludeGroups: [],
  minMessageLength: 0,
  downloadAttachments: false,
  maxAttachmentSize: 10 * 1024 * 1024,  // 10MB
};

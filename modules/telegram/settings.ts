/**
 * Telegram Module Settings
 * 
 * TypeScript types for module settings - mirrors module.json schema.
 * Used for type-safe access to settings fetched via ctx.fetchInternalSettings("telegram").
 */

export interface TelegramSettings {
  /** Whether the module is enabled */
  enabled: boolean;
  
  /** Telegram API ID from my.telegram.org */
  apiId: number;
  
  /** Telegram API hash from my.telegram.org (secret) */
  apiHash: string;
  
  /** MTProto session string - generated during authentication (secret) */
  sessionString: string;
  
  /** Hours of history to fetch on first run (default 168 = 7 days) */
  lookbackHours: number;
  
  /** 
   * JSON array of dialog types to collect.
   * Valid values: "channel", "supergroup", "group", "private"
   * Default: all types
   */
  collectDialogTypes: string;
  
  /** Skip archived chats (default true) */
  excludeArchived: boolean;
  
  /** Include user's Saved Messages (default true) */
  collectSavedMessages: boolean;
  
  /** 
   * JSON array of dialog IDs to collect.
   * If non-empty, ONLY these dialogs will be collected.
   * Empty array means collect all dialogs matching other filters.
   */
  includeDialogIds: string;
  
  /** JSON array of dialog IDs to never collect (blacklist) */
  excludeDialogIds: string;
  
  /** Skip messages shorter than this character count */
  minMessageLength: number;
  
  /** 
   * Safety multiplier for FLOOD_WAIT durations.
   * If Telegram says wait 60s, we wait 60 * multiplier seconds.
   */
  floodWaitMultiplier: number;
  
  /** AI prompt for generating context summaries */
  contextPrompt: string;
  
  /** Fallback prompt if JSON parsing fails */
  contextPromptFallback: string;
}

/** Dialog types supported by Telegram */
export type TelegramDialogType = 'channel' | 'supergroup' | 'group' | 'private';

/** Parse the collectDialogTypes JSON string to typed array */
export function parseDialogTypes(jsonString: string): TelegramDialogType[] {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) return ['channel', 'supergroup', 'group', 'private'];
    return parsed.filter((t): t is TelegramDialogType => 
      ['channel', 'supergroup', 'group', 'private'].includes(t)
    );
  } catch {
    return ['channel', 'supergroup', 'group', 'private'];
  }
}

/** Parse dialog ID list from JSON string */
export function parseDialogIds(jsonString: string): string[] {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String);
  } catch {
    return [];
  }
}

/** Context key format for Telegram messages */
export function buildContextKey(dialogId: string | number, threadId: number = 0): string {
  return `telegram:${dialogId}:${threadId}`;
}

/** Parse a context key back to components */
export function parseContextKey(key: string): { dialogId: string; threadId: number } | null {
  const match = key.match(/^telegram:(-?\d+|self):(\d+)$/);
  if (!match || !match[1] || !match[2]) return null;
  return {
    dialogId: match[1],
    threadId: parseInt(match[2], 10),
  };
}

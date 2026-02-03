-- Signal Module Schema
-- Private schema for Signal message storage
-- 
-- IMPORTANT: Signal is E2E encrypted. Messages here are only from AFTER
-- device linking. Historical messages cannot be imported.

-- Create private schema
CREATE SCHEMA IF NOT EXISTS mod_signal;

-- Main messages table
-- Stores decrypted messages received via signal-cli
CREATE TABLE IF NOT EXISTS mod_signal.signal_messages (
  id SERIAL PRIMARY KEY,
  
  -- Signal message identifiers
  timestamp BIGINT NOT NULL,           -- Signal timestamp in milliseconds
  source_phone VARCHAR(20) NOT NULL,   -- Sender phone (E.164 format: +15551234567)
  source_uuid VARCHAR(50),             -- Sender UUID (newer Signal versions)
  
  -- Conversation context
  group_id VARCHAR(200),               -- NULL for 1:1 chats, base64 for groups
  
  -- Message content
  body TEXT,                           -- Decrypted message text (may be NULL for media-only)
  message_type VARCHAR(20) NOT NULL DEFAULT 'data',  -- 'data', 'reaction', 'receipt'
  
  -- Disappearing message handling
  expires_in_seconds INTEGER,          -- Timer if set, NULL otherwise
  view_once BOOLEAN DEFAULT false,     -- View-once media flag
  
  -- Reactions (if this message IS a reaction)
  reaction_emoji VARCHAR(10),          -- Emoji if this is a reaction
  reaction_target_timestamp BIGINT,    -- Timestamp of message being reacted to
  
  -- Reply/quote info
  quote_id BIGINT,                     -- Timestamp of quoted message
  quote_author VARCHAR(20),            -- Phone of quoted message author
  quote_text TEXT,                     -- Preview text of quoted message
  
  -- Attachments (metadata only by default)
  has_attachments BOOLEAN DEFAULT false,
  attachment_count INTEGER DEFAULT 0,
  
  -- Raw data for debugging/reprocessing
  raw_envelope JSONB,                  -- Full signal-cli message envelope
  
  -- FeedEater metadata
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Deduplication: Signal timestamps are unique per sender
  UNIQUE(timestamp, source_phone)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_signal_messages_timestamp 
  ON mod_signal.signal_messages(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_signal_messages_source 
  ON mod_signal.signal_messages(source_phone);

CREATE INDEX IF NOT EXISTS idx_signal_messages_group 
  ON mod_signal.signal_messages(group_id) 
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_messages_collected 
  ON mod_signal.signal_messages(collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_messages_type 
  ON mod_signal.signal_messages(message_type);

-- Attachments table (if downloadAttachments is enabled)
CREATE TABLE IF NOT EXISTS mod_signal.signal_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES mod_signal.signal_messages(id) ON DELETE CASCADE,
  
  -- Attachment metadata
  content_type VARCHAR(100),           -- MIME type
  filename VARCHAR(500),               -- Original filename if provided
  size INTEGER,                        -- Size in bytes
  
  -- Storage
  stored_path VARCHAR(500),            -- Path if downloaded, NULL otherwise
  downloaded_at TIMESTAMPTZ,           -- When downloaded (NULL if not)
  
  -- signal-cli reference (for on-demand download)
  signal_attachment_id VARCHAR(200),   -- signal-cli's attachment reference
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_attachments_message 
  ON mod_signal.signal_attachments(message_id);

-- Embeddings for semantic search
-- Using same dimension as other modules (configurable via platform)
CREATE TABLE IF NOT EXISTS mod_signal.signal_message_embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES mod_signal.signal_messages(id) ON DELETE CASCADE,
  embedding vector(4096),              -- Match platform embedding dimension
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- IVFFlat index for similarity search (only works for dims <= 2000)
-- Uncomment if using smaller embedding dimension:
-- CREATE INDEX IF NOT EXISTS idx_signal_embeddings_ivfflat 
--   ON mod_signal.signal_message_embeddings 
--   USING ivfflat (embedding vector_cosine_ops) 
--   WITH (lists = 100);

-- Session health tracking
CREATE TABLE IF NOT EXISTS mod_signal.signal_session_health (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR(20) NOT NULL,
  
  checked_at TIMESTAMPTZ DEFAULT NOW(),
  is_alive BOOLEAN NOT NULL,
  linked_device_active BOOLEAN,
  
  error_message TEXT,                  -- If check failed
  
  -- Last successful receive
  last_message_at TIMESTAMPTZ,
  messages_since_check INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_signal_session_health_phone 
  ON mod_signal.signal_session_health(phone_number, checked_at DESC);

-- Collection state (track what we've processed)
CREATE TABLE IF NOT EXISTS mod_signal.signal_collection_state (
  phone_number VARCHAR(20) PRIMARY KEY,
  
  -- Last processed timestamp per conversation
  last_timestamps JSONB DEFAULT '{}',  -- { "group.xxx": 123456, "+15551234567": 789012 }
  
  -- Collection stats
  total_messages_collected INTEGER DEFAULT 0,
  total_groups_tracked INTEGER DEFAULT 0,
  total_contacts_tracked INTEGER DEFAULT 0,
  
  -- Linking info
  linked_at TIMESTAMPTZ,
  last_successful_collect TIMESTAMPTZ,
  
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

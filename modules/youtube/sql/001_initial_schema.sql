-- YouTube Module Schema
-- This migration creates the private schema for the YouTube module

CREATE SCHEMA IF NOT EXISTS mod_youtube;

-- Channels table (cached channel metadata)
CREATE TABLE IF NOT EXISTS mod_youtube.youtube_channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    thumbnail_url TEXT,
    custom_url TEXT,
    subscriber_count BIGINT,
    video_count BIGINT,
    uploads_playlist_id TEXT,
    last_fetched_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Videos table (collected videos)
CREATE TABLE IF NOT EXISTS mod_youtube.youtube_videos (
    video_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES mod_youtube.youtube_channels(channel_id),
    title TEXT NOT NULL,
    description TEXT,
    thumbnail_url TEXT,
    published_at TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER, -- NULL if fetched via RSS only
    view_count BIGINT, -- NULL if fetched via RSS only
    like_count BIGINT,
    comment_count BIGINT,
    is_short BOOLEAN DEFAULT FALSE,
    is_live BOOLEAN DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'rss', -- 'rss' or 'api'
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel_id ON mod_youtube.youtube_videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_published_at ON mod_youtube.youtube_videos(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_source ON mod_youtube.youtube_videos(source);

-- Embeddings table (for semantic search)
CREATE TABLE IF NOT EXISTS mod_youtube.youtube_video_embeddings (
    video_id TEXT PRIMARY KEY REFERENCES mod_youtube.youtube_videos(video_id) ON DELETE CASCADE,
    embedding vector(4096), -- Default Ollama nomic-embed-text dimensions
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Note: IVFFlat indexes only work for dims <= 2000
-- For 4096 dims, use HNSW index or no index (exact search)
-- CREATE INDEX IF NOT EXISTS idx_youtube_embeddings_vector ON mod_youtube.youtube_video_embeddings 
--     USING hnsw (embedding vector_cosine_ops);

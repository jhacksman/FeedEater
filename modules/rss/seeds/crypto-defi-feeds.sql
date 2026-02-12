-- Crypto/DeFi RSS Feed Configuration
-- High-quality feeds covering DeFi, crypto news, security, and protocol updates

INSERT INTO mod_rss.feeds (url, title, site_url, description, poll_interval_minutes, enabled, tags)
VALUES
  (
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'CoinDesk',
    'https://www.coindesk.com',
    'Leader in crypto news, covering Bitcoin, Ethereum, DeFi, and digital assets',
    15,
    true,
    '{"category": "crypto-news", "priority": "high"}'::jsonb
  ),
  (
    'https://www.theblock.co/rss.xml',
    'The Block',
    'https://www.theblock.co',
    'Crypto research and news — DeFi protocols, on-chain data, institutional crypto',
    15,
    true,
    '{"category": "crypto-news", "priority": "high"}'::jsonb
  ),
  (
    'https://blockworks.co/feed',
    'Blockworks',
    'https://blockworks.co',
    'Institutional crypto intelligence — DeFi, DAOs, NFTs, regulation',
    15,
    true,
    '{"category": "crypto-news", "priority": "high"}'::jsonb
  ),
  (
    'https://cointelegraph.com/rss',
    'Cointelegraph',
    'https://cointelegraph.com',
    'Crypto and blockchain news — markets, DeFi, regulation, technology',
    15,
    true,
    '{"category": "crypto-news", "priority": "medium"}'::jsonb
  ),
  (
    'https://rekt.news/feed.xml',
    'Rekt News',
    'https://rekt.news',
    'DeFi exploit postmortems and security analysis — hacks, rugs, vulnerabilities',
    30,
    true,
    '{"category": "defi-security", "priority": "high"}'::jsonb
  ),
  (
    'https://www.dlnews.com/arc/outboundfeeds/rss/',
    'DL News',
    'https://www.dlnews.com',
    'Decentralized finance news and analysis — protocols, yields, governance',
    30,
    true,
    '{"category": "defi-news", "priority": "medium"}'::jsonb
  ),
  (
    'https://blog.ethereum.org/feed.xml',
    'Ethereum Foundation Blog',
    'https://blog.ethereum.org',
    'Official Ethereum Foundation updates — EIPs, protocol upgrades, research',
    60,
    true,
    '{"category": "protocol-updates", "priority": "high"}'::jsonb
  )
ON CONFLICT (url) DO NOTHING;

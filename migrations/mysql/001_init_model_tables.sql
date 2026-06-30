CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(191) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_color VARCHAR(64) NOT NULL,
  avatar_url TEXT,
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id VARCHAR(64) PRIMARY KEY,
  from_user_id VARCHAR(64) NOT NULL,
  to_user_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NULL,
  INDEX idx_friend_requests_to (to_user_id, status)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a_id VARCHAR(64) NOT NULL,
  user_b_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  member_ids_json JSON NOT NULL,
  created_at VARCHAR(32) NOT NULL
);

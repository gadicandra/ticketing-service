CREATE TABLE IF NOT EXISTS seats (
  event_id        VARCHAR(40)  NOT NULL,
  seat_id         VARCHAR(8)   NOT NULL,
  price           INT UNSIGNED NOT NULL,
  status          ENUM('AVAILABLE','HELD','SOLD') NOT NULL DEFAULT 'AVAILABLE',
  buyer_id        VARCHAR(64)  NULL,
  hold_token      CHAR(36)     NULL,
  hold_expires_at INT UNSIGNED NULL,
  order_id        CHAR(36)     NULL,
  sold_at         INT UNSIGNED NULL,
  created_at      INT UNSIGNED NOT NULL,
  PRIMARY KEY (event_id, seat_id)
) ENGINE=InnoDB;

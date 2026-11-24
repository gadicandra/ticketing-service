import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";

// One small pool per Lambda execution environment, reused across warm invocations.
// ponytail: no RDS Proxy in the sandbox; connectionLimit 2 × Lambda concurrency must stay under RDS max_connections.
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === "off" ? undefined : "Amazon RDS",   // CA bundle shipped with mysql2
  connectionLimit: 2,
});

const HOLD_SECONDS = Number(process.env.HOLD_SECONDS ?? 300);   // waktu checkout
const EVENT_RE = /^[a-z0-9-]{3,40}$/;          // slug event, mis. konser-2026
const SEAT_RE = /^[A-Z]{1,2}-[1-9]\d{0,2}$/;   // A-1 … ZZ-999
const BUYER_RE = /^[\w.@-]{3,64}$/;
const TOKEN_RE = /^[0-9a-f-]{36}$/;            // UUID dari randomUUID()
const STATUSES = ["AVAILABLE", "HELD", "SOLD"];

const now = () => Math.floor(Date.now() / 1000);

const res = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: body === undefined ? "" : JSON.stringify(body),
});

// Public view: secrets never leave the API, and an expired hold reads as AVAILABLE (lazy expiry).
const view = (r) => {
  const held = r.status === "HELD" && r.hold_expires_at > now();
  return {
    eventId: r.event_id,
    seatId: r.seat_id,
    price: r.price,
    status: r.status === "HELD" && !held ? "AVAILABLE" : r.status,
    ...(held && { holdExpiresAt: r.hold_expires_at }),
  };
};

const getSeat = async (eventId, seatId) =>
  (await db.execute("SELECT * FROM seats WHERE event_id = ? AND seat_id = ?", [eventId, seatId]))[0][0];

// A conditional UPDATE changed 0 rows: read the row once to say why.
const conflict = async (route, eventId, seatId, token) => {
  const old = await getSeat(eventId, seatId);
  if (!old) return res(404, { message: "seat not found" });
  if (route.endsWith("/confirm")) {
    if (old.status === "SOLD")
      return old.order_id === token
        ? res(200, { orderId: token, seat: view(old), idempotent: true })   // retry webhook pembayaran
        : res(409, { reason: "SEAT_SOLD" });
    if (old.status !== "HELD" || old.hold_token !== token) return res(403, { reason: "INVALID_HOLD" });
    return res(410, { reason: "HOLD_EXPIRED" });
  }
  return res(409, { reason: old.status === "SOLD" ? "SEAT_SOLD" : "SEAT_HELD" });   // hold, PUT, DELETE
};

// Function URL has no route table: build "METHOD /events/{eventId}/seats/..." ourselves.
const route = (event) => {
  const method = event.requestContext?.http?.method;
  const m = (event.rawPath ?? "").match(/^\/events\/([^/]+)\/seats(?:\/([^/]+))?(?:\/(hold|confirm))?\/?$/);
  if (!m) return {};
  const [, eventId, seatId, action] = m;
  const key = `${method} /events/{eventId}/seats${seatId ? "/{seatId}" : ""}${action ? "/" + action : ""}`;
  return { key, eventId: decodeURIComponent(eventId), seatId: seatId && decodeURIComponent(seatId).toUpperCase() };
};

export const handler = async (event) => {
  const { key, eventId, seatId } = route(event);
  if (!key) return res(404, { message: "route not found" });
  if (!EVENT_RE.test(eventId)) return res(400, { message: "invalid eventId" });
  if (seatId !== undefined && !SEAT_RE.test(seatId)) return res(400, { message: "invalid seatId" });

  let data;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body;
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return res(400, { message: "invalid JSON body" });
  }

  try {
    switch (key) {
      // ---------- Pembeli: hold → confirm ----------
      case "POST /events/{eventId}/seats/{seatId}/hold": {
        const buyerId = String(data.buyerId ?? "").trim();
        if (!BUYER_RE.test(buyerId)) return res(400, { message: "valid buyerId is required" });
        const holdToken = randomUUID();
        const holdExpiresAt = now() + HOLD_SECONDS;
        // Atomic hold: the WHERE clause is the availability check, so only one concurrent UPDATE can win.
        const [r] = await db.execute(
          `UPDATE seats
              SET status = 'HELD', buyer_id = ?, hold_token = ?, hold_expires_at = ?
            WHERE event_id = ? AND seat_id = ?
              AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= ?))`,
          [buyerId, holdToken, holdExpiresAt, eventId, seatId, now()],
        );
        if (r.affectedRows !== 1) return conflict(key, eventId, seatId);
        return res(200, { holdToken, holdExpiresAt, seat: view(await getSeat(eventId, seatId))});
      }
      case "POST /events/{eventId}/seats/{seatId}/confirm": {
        const holdToken = String(data.holdToken ?? "");
        if (!TOKEN_RE.test(holdToken)) return res(400, { message: "valid holdToken is required" });
        const t = now();
        const [r] = await db.execute(
          `UPDATE seats
              SET status = 'SOLD', order_id = ?, sold_at = ?, hold_token = NULL, hold_expires_at = NULL
            WHERE event_id = ? AND seat_id = ?
              AND status = 'HELD' AND hold_token = ? AND hold_expires_at > ?`,
          [holdToken, t, eventId, seatId, holdToken, t],
        );
        if (r.affectedRows !== 1) return conflict(key, eventId, seatId, holdToken);
        return res(200, { orderId: holdToken, seat: view(await getSeat(eventId, seatId)) });
      }

      // ---------- Admin & publik: CRUD kursi ----------
      case "POST /events/{eventId}/seats": {
        const newSeat = String(data.seatId ?? "").trim().toUpperCase();
        if (!SEAT_RE.test(newSeat) || !Number.isInteger(data.price) || data.price < 0)
          return res(400, { message: "valid seatId and integer price (IDR) are required" });
        const [r] = await db.execute(
          "INSERT IGNORE INTO seats (event_id, seat_id, price, created_at) VALUES (?, ?, ?, ?)",
          [eventId, newSeat, data.price, now()],
        );
        if (r.affectedRows !== 1) return res(409, { message: "seat already exists" });
        return res(201, view(await getSeat(eventId, newSeat)));
      }
      case "GET /events/{eventId}/seats": {
        const status = event.queryStringParameters?.status;
        if (status !== undefined && !STATUSES.includes(status))
          return res(400, { message: "status must be AVAILABLE, HELD or SOLD" });
        const [rows] = await db.execute("SELECT * FROM seats WHERE event_id = ? ORDER BY seat_id", [eventId]);
        const seats = rows.map(view);   // filter after view(): an expired HELD must count as AVAILABLE
        return res(200, status ? seats.filter((s) => s.status === status) : seats);
      }
      case "GET /events/{eventId}/seats/{seatId}": {
        const row = await getSeat(eventId, seatId);
        return row ? res(200, view(row)) : res(404, { message: "seat not found" });
      }
      case "PUT /events/{eventId}/seats/{seatId}": {
        if (!Number.isInteger(data.price) || data.price < 0)
          return res(400, { message: "integer price (IDR) is required" });
        const [r] = await db.execute(
          "UPDATE seats SET price = ? WHERE event_id = ? AND seat_id = ? AND status <> 'SOLD'",
          [data.price, eventId, seatId],
        );
        if (r.affectedRows !== 1) return conflict(key, eventId, seatId);
        return res(200, view(await getSeat(eventId, seatId)));
      }
      case "DELETE /events/{eventId}/seats/{seatId}": {
        const [r] = await db.execute(
          `DELETE FROM seats WHERE event_id = ? AND seat_id = ?
              AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= ?))`,
          [eventId, seatId, now()],
        );
        if (r.affectedRows !== 1) return conflict(key, eventId, seatId);
        return res(204);
      }
      default:
        return res(404, { message: "route not found" });
    }
  } catch (err) {
    console.error(err);
    return res(500, { message: "internal error" });
  }
};

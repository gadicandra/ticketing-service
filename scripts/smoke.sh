#!/usr/bin/env bash
# usage: API_URL=https://xxxx.lambda-url.us-east-1.on.aws ./scripts/smoke.sh
set -euo pipefail
: "${API_URL:?set API_URL}"
API_URL=${API_URL%/}

check() { # expected_status method path [body]
  local code
  code=$(curl -s -o /tmp/body -w '%{http_code}' -X "$2" "$API_URL$3" \
    -H 'content-type: application/json' ${4:+-d "$4"})
  echo "$2 $3 -> $code $(cat /tmp/body)"
  [[ "$code" == "$1" ]] || { echo "FAIL: expected $1"; exit 1; }
}

S="/events/smoke-$(date +%s)/seats"     # acara baru tiap run, supaya script bisa diulang
check 201 POST "$S" '{"seatId":"A-1","price":150000}'
check 201 POST "$S" '{"seatId":"A-2","price":150000}'
check 409 POST "$S" '{"seatId":"A-1","price":150000}'           # kursi dobel
check 400 POST "$S" '{"seatId":"lantai","price":-1}'            # validasi input
check 404 POST "$S/Z-999/hold" '{"buyerId":"buyer-1"}'          # kursi tidak pernah dibuat
check 200 POST "$S/A-1/hold" '{"buyerId":"buyer-1"}'            # HOLD (501 sampai TODO(human) selesai)
TOKEN=$(sed -E 's/.*"holdToken":"([^"]+)".*/\1/' /tmp/body)
check 409 POST "$S/A-1/hold" '{"buyerId":"buyer-2"}'            # SEAT_HELD
check 200 GET  "$S/A-1"
if grep -q -i token /tmp/body; then echo "FAIL: holdToken leaked"; exit 1; fi
check 403 POST "$S/A-1/confirm" '{"holdToken":"00000000-0000-0000-0000-000000000000"}'   # INVALID_HOLD
check 200 POST "$S/A-1/confirm" "{\"holdToken\":\"$TOKEN\"}"    # SOLD
check 200 POST "$S/A-1/confirm" "{\"holdToken\":\"$TOKEN\"}"    # notifikasi ganda → tetap 200
check 409 POST "$S/A-1/hold" '{"buyerId":"buyer-2"}'            # SEAT_SOLD
check 409 PUT  "$S/A-1" '{"price":99000}'                       # harga kursi terjual dikunci
check 200 PUT  "$S/A-2" '{"price":175000}'
check 200 GET  "$S?status=AVAILABLE"
check 409 DELETE "$S/A-1"                                       # kursi terjual tidak bisa dihapus
check 204 DELETE "$S/A-2"
check 404 GET  "$S/A-2"
echo "ALL PASSED"

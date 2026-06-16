#!/bin/bash
# App Store Connect API helper — dependency-free (openssl + curl + python3 only).
#
# Usage:
#   set -a; source /path/to/.appstoreconnect.env; set +a   # exports APPSTORE_API_KEY_ID / _ISSUER_ID / _PRIVATE_KEY_PATH
#   source scripts/asc.sh
#   asc GET  "/v1/apps?filter[bundleId]=com.example.MyApp"
#   asc POST "/v1/betaGroups" '{"data":{...}}'
#
# Requires the three APPSTORE_* env vars to be set. Mints a fresh 5-minute ES256
# JWT per call (cheap), signing with the .p8 via openssl — no pyjwt needed.
#
# NOTE: over non-interactive ssh, login shells sometimes have a bare PATH and
# Homebrew's openssl/xxd won't resolve. Ensure a usable PATH before sourcing, e.g.
#   export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
# (macOS /usr/bin openssl works too; xxd ships in /usr/bin.)

_asc_b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }

asc_jwt() {
  : "${APPSTORE_API_KEY_ID:?set APPSTORE_API_KEY_ID}"
  : "${APPSTORE_ISSUER_ID:?set APPSTORE_ISSUER_ID}"
  : "${APPSTORE_API_PRIVATE_KEY_PATH:?set APPSTORE_API_PRIVATE_KEY_PATH}"
  local now header payload signing_input sig
  now=$(date +%s)
  header=$(printf '{"alg":"ES256","kid":"%s","typ":"JWT"}' "$APPSTORE_API_KEY_ID" | _asc_b64url)
  payload=$(printf '{"iss":"%s","iat":%d,"exp":%d,"aud":"appstoreconnect-v1"}' \
            "$APPSTORE_ISSUER_ID" "$now" "$((now+300))" | _asc_b64url)
  signing_input="$header.$payload"
  # openssl produces a DER ECDSA signature; JWT needs raw r||s (two 32-byte ints).
  sig=$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$APPSTORE_API_PRIVATE_KEY_PATH" \
        | openssl asn1parse -inform DER 2>/dev/null | awk '/INTEGER/{print $NF}' \
        | sed 's/://g' | while read -r h; do printf '%064s' "$h" | tr ' ' 0; done \
        | xxd -r -p | _asc_b64url)
  printf '%s.%s' "$signing_input" "$sig"
}

# asc METHOD PATH [JSON_BODY]
asc() {
  local method="$1" path="$2" body="${3:-}" jwt
  jwt=$(asc_jwt) || return 1
  if [ -n "$body" ]; then
    curl -s -X "$method" "https://api.appstoreconnect.apple.com${path}" \
      -H "Authorization: Bearer $jwt" -H "Content-Type: application/json" -d "$body"
  else
    curl -s -X "$method" "https://api.appstoreconnect.apple.com${path}" \
      -H "Authorization: Bearer $jwt"
  fi
}

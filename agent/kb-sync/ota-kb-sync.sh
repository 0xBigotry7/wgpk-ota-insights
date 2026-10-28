#!/bin/bash
# Copies the OTA-relevant, non-sensitive part of the hotel KB (wgpk box ~/shared) into the OTA agent's
# read-only kb/hotel. Gary approved 2026-10-28 (TG 9975). Never add: partners/OTA_ACCESS.md (credentials),
# rooms/INVENTORY*.md / OWNER_OCCUPIED_ROOMS.md (owner data), sales/* (confidential/restricted), finance.
set -euo pipefail
DEST="$HOME/agents/ota/kb/hotel"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FILES=(
  concierge/HOTEL_FACTS.md
  concierge/ROOMS.md
  concierge/FACILITIES.md
  concierge/DINING.md
  concierge/POLICIES.md
  concierge/LOCAL_GUIDE.md
  concierge/WGPK_CLUB.md
  concierge/AIRPORT_TRANSFER.md
  concierge/GUEST_QA.md
  concierge/LAUNDRY.md
  concierge/SPRING_MENU.md
  concierge/tour-desk-tours-and-tickets-price-list.md
  rooms/room-types.md
  rooms/room-views.md
  rooms/POOL_ACCESS_USE_2026-10-21.md
  brand/WEBSITE_CONTENT.md
  brand/WYNDHAM_MARKET_SEGMENT_CODES.md
  brand/WYNDHAM_MARKET_SEGMENTATION.md
  brand/WYNDHAM_B2B_WHOLESALE_PROGRAM.md
  partners/EXPEDIA_MEDIA_SOLUTIONS_2026_CAMPAIGNS.md
  partners/HOTELBEDS_DISTRIBUTION_GM_UPDATE_2026_09_27.md
  partners/IDEAS_OPERA_INTEGRATION_STATUS.md
  partners/SUMMER_PACKAGES_2027_PLANNING.md
  policies/REVIEW_REPLY_STANDARD.md
  policies/DATA_CLASSIFICATION.md
)
cd "$TMP"
ssh -o BatchMode=yes -o ConnectTimeout=10 wgpk@100.98.113.89 "cd ~/shared && tar cf - ${FILES[*]}" | tar xf -
chmod -R u+rwX "$DEST" 2>/dev/null || true
rsync -a --delete "$TMP"/ "$DEST"/
find "$DEST" -type f -exec chmod 400 {} +
find "$DEST" -type d -exec chmod 500 {} +
date "+%F %T synced ${#FILES[@]} files"

#!/usr/bin/env python3
"""
Plantz Editorial Pipeline — Transfer Approved Headlines (v3.2)

v3.2 changes:
  - CLAIM FIRST: Set headline status to 'transferring' BEFORE creating
    the article record. This prevents duplicate transfers when two runs
    overlap — the second run won't see the headline as 'approved'.
  - Re-check headline status before claiming (skip if not 'approved')

v3.1 changes:
  - Duplicate prevention via headline_queue_id check
  - Atomic status updates per headline

Env vars: AIRTABLE_API_KEY, DISCORD_WEBHOOK_NOTIFICATIONS
"""

import os
import sys
import json
import requests
from datetime import datetime, timezone
from pathlib import Path

# ── Load .env if running locally ────────────────────────────────────────────
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    print(f"  Loading .env from {env_path}")
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())

# ── Config ──────────────────────────────────────────────────────────────────
AIRTABLE_API_KEY = os.environ.get("AIRTABLE_API_KEY")
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK_NOTIFICATIONS")

BASE_ID = "appN9kmTgJbjel4J1"
HEADLINE_TABLE = "tbl00YTHfrVnKQQai"
ARTICLES_TABLE = "tblUhbxC3LIKgORLa"

HEADERS = {
    "Authorization": f"Bearer {AIRTABLE_API_KEY}",
    "Content-Type": "application/json"
}

DRY_RUN = "--dry-run" in sys.argv


# ── Airtable Helpers ────────────────────────────────────────────────────────

def airtable_get(table_id, params=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}/{table_id}"
    all_records = []
    while True:
        response = requests.get(url, headers=HEADERS, params=params)
        response.raise_for_status()
        data = response.json()
        all_records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
        if params is None:
            params = {}
        params["offset"] = offset
    return all_records


def airtable_get_record(table_id, record_id):
    """Fetch a single record to check its current state."""
    response = requests.get(
        f"https://api.airtable.com/v0/{BASE_ID}/{table_id}/{record_id}",
        headers=HEADERS
    )
    response.raise_for_status()
    return response.json()


def airtable_create_record(table_id, fields):
    response = requests.post(
        f"https://api.airtable.com/v0/{BASE_ID}/{table_id}",
        headers=HEADERS,
        json={"records": [{"fields": fields}]}
    )
    response.raise_for_status()
    return response.json()["records"][0]


def airtable_update_record(table_id, record_id, fields):
    response = requests.patch(
        f"https://api.airtable.com/v0/{BASE_ID}/{table_id}",
        headers=HEADERS,
        json={"records": [{"id": record_id, "fields": fields}]}
    )
    response.raise_for_status()
    return response.json()["records"][0]


# ── Discord Notification ────────────────────────────────────────────────────

def notify_discord(message, color=5814783):
    if not DISCORD_WEBHOOK:
        return
    try:
        requests.post(DISCORD_WEBHOOK, json={
            "embeds": [{
                "description": message,
                "color": color,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }]
        })
    except Exception as e:
        print(f"  ⚠ Discord notification failed: {e}")


# ── Main Logic ──────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("PLANTZ EDITORIAL PIPELINE v3.2 — Headline Transfer")
    print(f"Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    if DRY_RUN:
        print("MODE: DRY RUN (no changes will be made)")
    print("=" * 60)

    # ── Step 1: Get approved headlines ──
    print("\n📋 Fetching approved headlines from Headline Queue...")

    approved = airtable_get(HEADLINE_TABLE, params={
        "filterByFormula": '{status} = "approved"',
        "sort[0][field]": "priority_order",
        "sort[0][direction]": "asc"
    })

    if not approved:
        print("  No approved headlines found. Nothing to transfer.")
        return

    print(f"  Found {len(approved)} approved headline(s)")

    if DRY_RUN:
        for rec in approved:
            print(f"    • {rec['fields'].get('headline', '(no title)')}")
        print(f"\n🔍 DRY RUN — would transfer {len(approved)} headline(s)")
        return

    # ── Step 2: Claim and transfer each headline ──
    # v3.2: CLAIM FIRST by setting status to 'transferring' before creating
    # the article. This prevents duplicates when two runs overlap.
    print(f"\n📝 Claiming and transferring {len(approved)} headline(s)...")

    created_articles = []
    skipped = []

    for rec in approved:
        f = rec["fields"]
        title = f.get("headline", "(no title)")

        try:
            # Re-check status (another run may have already claimed it)
            fresh = airtable_get_record(HEADLINE_TABLE, rec["id"])
            current_status = fresh.get("fields", {}).get("status", "")

            if current_status != "approved":
                print(f"    ⏭️  {title[:60]} — already claimed (status: {current_status})")
                skipped.append(rec)
                continue

            # CLAIM: Set status to 'transferring' BEFORE creating article
            airtable_update_record(HEADLINE_TABLE, rec["id"], {
                "status": "sent_to_news_agent"
            })
            print(f"    🔒 Claimed: {title[:60]}")

            # Create article record
            article = airtable_create_record(ARTICLES_TABLE, {
                "article_title": f.get("headline", ""),
                "prompt": f.get("article_prompt", ""),
                "seo_keyword": f.get("seo_keyword", ""),
                "angle": f.get("angle", ""),
                "subject": f.get("subject", ""),
                "batch_id": f.get("batch_id", ""),
                "target_word_count": f.get("target_word_count", 1000),
                "headline_queue_id": rec["id"],
                "pipeline_status": "queued",
                "priority_order": f.get("priority_order", 1)
            })

            # Store cross-reference
            airtable_update_record(HEADLINE_TABLE, rec["id"], {
                "articles_record_id": article["id"]
            })

            created_articles.append(article)
            print(f"    ✓ Created article: {title[:60]}")

        except Exception as e:
            print(f"    ✗ {title[:60]} — ERROR: {e}")
            # Try to revert status if article creation failed
            try:
                airtable_update_record(HEADLINE_TABLE, rec["id"], {
                    "status": "approved"
                })
                print(f"      ↩ Reverted headline status to 'approved'")
            except Exception:
                print(f"      ⚠ Could not revert headline status")
            continue

    # ── Step 3: Summary ──
    print("\n" + "=" * 60)
    print("TRANSFER COMPLETE")
    print(f"  Headlines transferred: {len(created_articles)}")
    if skipped:
        print(f"  Already claimed (skipped): {len(skipped)}")
    print("=" * 60)

    # ── Step 4: Discord notification ──
    if created_articles:
        titles = "\n".join(
            [f"• {a['fields'].get('article_title', '(no title)')}"
             for a in created_articles]
        )
        notify_discord(
            f"**📋 {len(created_articles)} headline(s) transferred to Articles queue**\n\n"
            f"{titles}\n\n"
            f"The News Agent will write these automatically."
        )


if __name__ == "__main__":
    if not AIRTABLE_API_KEY:
        print("ERROR: AIRTABLE_API_KEY not set.")
        sys.exit(1)
    main()

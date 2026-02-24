#!/usr/bin/env python3
"""
Plantz Editorial Pipeline — Transfer Approved Headlines (v3)

Scans the Headline Queue for approved headlines and creates corresponding
records in the Articles table. Updates the Headline Queue status to
'sent_to_news_agent' and stores the cross-reference ID.

v3 changes:
  - Adds priority_order mapping
  - Does NOT map Publication Date (human sets it during review)

Runs as:
  - GitHub Actions (triggered by Zapier or manual dispatch)
  - Locally — auto-loads .env from project root

Usage:
    python3 transfer_headlines.py              # Transfer all approved headlines
    python3 transfer_headlines.py --dry-run    # Preview without making changes
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
DISCORD_WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL")

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
    """GET records from Airtable, handling pagination."""
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


def airtable_batch_create(table_id, records):
    """Create records in batches of 10 (Airtable limit)."""
    created = []
    for i in range(0, len(records), 10):
        batch = records[i:i+10]
        response = requests.post(
            f"https://api.airtable.com/v0/{BASE_ID}/{table_id}",
            headers=HEADERS,
            json={"records": [{"fields": r} for r in batch]}
        )
        response.raise_for_status()
        created.extend(response.json()["records"])
    return created


def airtable_batch_update(table_id, records):
    """Update records in batches of 10 (Airtable limit)."""
    updated = []
    for i in range(0, len(records), 10):
        batch = records[i:i+10]
        response = requests.patch(
            f"https://api.airtable.com/v0/{BASE_ID}/{table_id}",
            headers=HEADERS,
            json={"records": batch}
        )
        response.raise_for_status()
        updated.extend(response.json()["records"])
    return updated


# ── Discord Notification ────────────────────────────────────────────────────

def notify_discord(message, color=5814783):
    """Send a notification to Discord. Default colour is Plantz sage green."""
    if not DISCORD_WEBHOOK:
        print("  ⚠ No Discord webhook configured, skipping notification")
        return

    payload = {
        "embeds": [{
            "description": message,
            "color": color,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }]
    }

    try:
        response = requests.post(DISCORD_WEBHOOK, json=payload)
        response.raise_for_status()
        print("  ✓ Discord notification sent")
    except Exception as e:
        print(f"  ⚠ Discord notification failed: {e}")


# ── Main Logic ──────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("PLANTZ EDITORIAL PIPELINE v3 — Headline Transfer")
    print(f"Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    if DRY_RUN:
        print("MODE: DRY RUN (no changes will be made)")
    print("=" * 60)

    # ── Step 1: Get approved headlines ──
    print("\n📋 Fetching approved headlines from Headline Queue...")

    approved = airtable_get(HEADLINE_TABLE, params={
        "filterByFormula": '{status} = "approved"',
        "sort[0][field]": "publish_date",
        "sort[0][direction]": "asc"
    })

    if not approved:
        print("  No approved headlines found. Nothing to transfer.")
        return

    print(f"  Found {len(approved)} approved headline(s):")
    for rec in approved:
        f = rec["fields"]
        print(f"    • {f.get('headline', '(no title)')}")
        print(f"      Angle: {f.get('angle', 'N/A')} | "
              f"Subject: {f.get('subject', 'N/A')}")

    if DRY_RUN:
        print(f"\n🔍 DRY RUN — would transfer {len(approved)} headline(s):")
        for rec in approved:
            f = rec["fields"]
            title = f.get("headline", "")
            print(f"    → {title[:70]}{'...' if len(title) > 70 else ''}")
            print(f"      pipeline_status: queued")
        print("\n  No changes made. Remove --dry-run to execute.")
        return

    # ── Step 2: Create article records ──
    print(f"\n📝 Creating {len(approved)} article record(s) in Articles table...")

    articles_to_create = []
    for rec in approved:
        f = rec["fields"]
        articles_to_create.append({
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
            # NOTE: Publication Date is NOT set here.
            # The human sets it during article review.
        })

    created_articles = airtable_batch_create(ARTICLES_TABLE, articles_to_create)
    print(f"  ✓ Created {len(created_articles)} article record(s)")

    # ── Step 3: Update headline queue ──
    print("\n🔄 Updating Headline Queue status to 'sent_to_news_agent'...")

    headline_updates = []
    for i, rec in enumerate(approved):
        headline_updates.append({
            "id": rec["id"],
            "fields": {
                "status": "sent_to_news_agent",
                "articles_record_id": created_articles[i]["id"]
            }
        })

    airtable_batch_update(HEADLINE_TABLE, headline_updates)
    print(f"  ✓ Updated {len(headline_updates)} headline record(s)")

    # ── Step 4: Summary ──
    print("\n" + "=" * 60)
    print("TRANSFER COMPLETE")
    print(f"  Headlines transferred: {len(created_articles)}")
    print(f"  Articles queued for News Agent:")
    for art in created_articles:
        f = art["fields"]
        print(f"    • {f.get('article_title', '(no title)')}")
        print(f"      Record ID: {art['id']}")
    print("=" * 60)

    # ── Step 5: Discord notification ──
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
        print("Either set it as an environment variable or ensure .env exists "
              "at the project root.")
        sys.exit(1)

    main()

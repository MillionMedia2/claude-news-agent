#!/usr/bin/env python3
"""
Plantz Editorial Pipeline — Transfer Approved Headlines (v3.1)

Scans the Headline Queue for approved headlines and creates corresponding
records in the Articles table. Updates the Headline Queue status to
'sent_to_news_agent' and stores the cross-reference ID.

v3.1 changes:
  - Duplicate prevention: skips headlines whose record ID already exists
    in Articles.headline_queue_id
  - Atomicity: updates headline status to 'sent_to_news_agent' immediately
    after creating each article, not in a separate batch at the end

Env vars (must match .env naming):
  AIRTABLE_API_KEY, DISCORD_WEBHOOK_NOTIFICATIONS

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


def airtable_create_record(table_id, fields):
    """Create a single record in Airtable."""
    response = requests.post(
        f"https://api.airtable.com/v0/{BASE_ID}/{table_id}",
        headers=HEADERS,
        json={"records": [{"fields": fields}]}
    )
    response.raise_for_status()
    return response.json()["records"][0]


def airtable_update_record(table_id, record_id, fields):
    """Update a single record in Airtable."""
    response = requests.patch(
        f"https://api.airtable.com/v0/{BASE_ID}/{table_id}",
        headers=HEADERS,
        json={"records": [{"id": record_id, "fields": fields}]}
    )
    response.raise_for_status()
    return response.json()["records"][0]


# ── Duplicate Check ───────────────────────────────────────────────────────

def get_existing_headline_ids():
    """Get all headline_queue_id values already in the Articles table.
    This prevents duplicate transfers if the workflow runs multiple times."""
    print("  Checking for already-transferred headlines...")
    existing = airtable_get(ARTICLES_TABLE, params={
        "fields[]": "headline_queue_id",
        "filterByFormula": "{headline_queue_id} != ''"
    })
    ids = set()
    for rec in existing:
        hq_id = rec.get("fields", {}).get("headline_queue_id", "")
        if hq_id:
            ids.add(hq_id)
    print(f"  Found {len(ids)} headline(s) already transferred")
    return ids


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
    print("PLANTZ EDITORIAL PIPELINE v3.1 — Headline Transfer")
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

    print(f"  Found {len(approved)} approved headline(s)")

    # ── Step 2: Filter out already-transferred headlines ──
    existing_ids = get_existing_headline_ids()

    new_headlines = []
    skipped = []
    for rec in approved:
        if rec["id"] in existing_ids:
            skipped.append(rec)
        else:
            new_headlines.append(rec)

    if skipped:
        print(f"  ⚠ Skipping {len(skipped)} already-transferred headline(s):")
        for rec in skipped:
            print(f"    • {rec['fields'].get('headline', '(no title)')} [DUPLICATE]")

    if not new_headlines:
        print("  All approved headlines have already been transferred. Nothing to do.")
        # Still update status on any that are stuck as 'approved' but already transferred
        if skipped:
            print("  Updating stuck headline statuses...")
            for rec in skipped:
                if not DRY_RUN:
                    airtable_update_record(HEADLINE_TABLE, rec["id"], {
                        "status": "sent_to_news_agent"
                    })
            print(f"  ✓ Updated {len(skipped)} headline(s) to 'sent_to_news_agent'")
        return

    print(f"\n  {len(new_headlines)} new headline(s) to transfer:")
    for rec in new_headlines:
        f = rec["fields"]
        print(f"    • {f.get('headline', '(no title)')}")
        print(f"      Angle: {f.get('angle', 'N/A')} | "
              f"Subject: {f.get('subject', 'N/A')}")

    if DRY_RUN:
        print(f"\n🔍 DRY RUN — would transfer {len(new_headlines)} headline(s)")
        print("  No changes made. Remove --dry-run to execute.")
        return

    # ── Step 3: Transfer each headline atomically ──
    print(f"\n📝 Transferring {len(new_headlines)} headline(s)...")

    created_articles = []
    for rec in new_headlines:
        f = rec["fields"]
        title = f.get("headline", "(no title)")

        try:
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

            # Immediately mark headline as transferred (prevents duplicates on retry)
            airtable_update_record(HEADLINE_TABLE, rec["id"], {
                "status": "sent_to_news_agent",
                "articles_record_id": article["id"]
            })

            created_articles.append(article)
            print(f"    ✓ {title[:60]}")

        except Exception as e:
            print(f"    ✗ {title[:60]} — ERROR: {e}")
            # Don't stop the whole batch for one failure
            continue

    # ── Step 4: Summary ──
    print("\n" + "=" * 60)
    print("TRANSFER COMPLETE")
    print(f"  Headlines transferred: {len(created_articles)}")
    if skipped:
        print(f"  Duplicates skipped:   {len(skipped)}")
    print(f"  Articles queued for News Agent:")
    for art in created_articles:
        f = art["fields"]
        print(f"    • {f.get('article_title', '(no title)')}")
        print(f"      Record ID: {art['id']}")
    print("=" * 60)

    # ── Step 5: Discord notification ──
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
        print("Either set it as an environment variable or ensure .env exists "
              "at the project root.")
        sys.exit(1)

    main()

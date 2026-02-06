# Plantz News Agent

Automated article generation pipeline for Plantz.io wellness content.

## How It Works

1. **Airtable Queue**: Articles with a `prompt` but no `written_article` are picked up
2. **Pinecone Search**: Evidence is retrieved from the herb_monographs knowledge base
3. **Claude Generation**: Article and supporting content (tags, excerpt, social posts) are generated
4. **Airtable Update**: Generated content is saved back to the record
5. **WordPress Publish**: If `post_to_wordpress` is checked, the article is published

## Scheduled Runs

The workflow runs daily at **1pm UK GMT** (13:00 UTC).

You can also trigger manually from GitHub Actions → "Generate Article from Airtable Queue" → "Run workflow"

## Required Secrets

Add these to GitHub Settings → Secrets → Actions:

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `AIRTABLE_API_KEY` | Airtable personal access token |
| `PINECONE_API_KEY` | Pinecone API key |
| `WORDPRESS_USER` | WordPress username |
| `WORDPRESS_APP_PASSWORD` | WordPress application password |

## Local Development

```bash
npm install

# Set environment variables
export ANTHROPIC_API_KEY=your-key
export AIRTABLE_API_KEY=your-key
export PINECONE_API_KEY=your-key
export WORDPRESS_USER=your-user
export WORDPRESS_APP_PASSWORD=your-password

# Run
npm run generate
```

## Files

- `.github/workflows/generate-article.yml` - Scheduled GitHub Action
- `scripts/generate-article.js` - Main generation script
- `scripts/test-connection.js` - Test API connections

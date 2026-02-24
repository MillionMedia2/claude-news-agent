/**
 * Plantz News Agent - Article Generation Script (v3)
 * 
 * Pipeline v3: Write immediately when queued (no date dependency).
 * Human sets Publication Date later during review.
 * 
 * This script:
 * 1. Checks Airtable for articles with pipeline_status = "queued"
 * 2. Sets pipeline_status to "writing"
 * 3. Queries Pinecone for evidence
 * 4. Calls Claude API to generate the article + supporting content
 * 5. Updates Airtable with generated content
 * 6. Sets pipeline_status to "review"
 * 7. Sends Discord notification
 */

import Anthropic from '@anthropic-ai/sdk';
import Airtable from 'airtable';
import { Pinecone } from '@pinecone-database/pinecone';

// Configuration
const CONFIG = {
  airtable: {
    baseId: 'appN9kmTgJbjel4J1',
    tableId: 'Articles'
  },
  pinecone: {
    indexName: 'plantz1',
    namespace: 'herb_monographs'
  },
  maxArticlesPerRun: 3
};

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

// ── Discord ────────────────────────────────────────────────────────────────

async function sendDiscordNotification(message, isError = false) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: isError ? '❌ Article Generation Error' : '✅ Article Ready for Review',
          description: message,
          color: isError ? 0xFF0000 : 0x58B09C, // Plantz sage green
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (error) {
    console.error('Failed to send Discord notification:', error);
  }
}

// ── Pipeline Status ────────────────────────────────────────────────────────

async function updatePipelineStatus(recordId, status) {
  return new Promise((resolve, reject) => {
    airtable(CONFIG.airtable.tableId).update(recordId, {
      'pipeline_status': status
    }, (err, record) => err ? reject(err) : resolve(record));
  });
}

// ── Get Queued Articles ────────────────────────────────────────────────────
// v3: No date check. Write anything that's queued, oldest first.

async function getQueuedArticles() {
  return new Promise((resolve, reject) => {
    const records = [];
    airtable(CONFIG.airtable.tableId)
      .select({
        maxRecords: CONFIG.maxArticlesPerRun,
        filterByFormula: `AND(
          {pipeline_status} = "queued",
          {written_article} = '',
          {prompt} != ''
        )`,
        sort: [
          { field: 'Created', direction: 'asc' }
        ]
      })
      .eachPage(
        (pageRecords, next) => { records.push(...pageRecords); next(); },
        (err) => err ? reject(err) : resolve(records)
      );
  });
}

// ── Pinecone Search ────────────────────────────────────────────────────────

async function searchPinecone(searchText) {
  try {
    const response = await fetch(
      `https://plantz1-aokppsg.svc.gcp-europe-west4-de1d.pinecone.io/records/namespaces/${CONFIG.pinecone.namespace}/search`,
      {
        method: 'POST',
        headers: {
          'Api-Key': process.env.PINECONE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: {
            topK: 10,
            inputs: { text: searchText }
          }
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`Pinecone search failed: ${response.status}`);
    }
    
    const data = await response.json();
    return data.result?.hits?.map(hit => hit.fields?.text || '').join('\n\n---\n\n') || '';
  } catch (error) {
    console.error('Pinecone search error:', error);
    return '';
  }
}

// ── Article Generation ─────────────────────────────────────────────────────

async function generateArticle(title, prompt, evidence) {
  const systemPrompt = `You are the Plantz News Agent, writing evidence-based wellness articles for Aisha - a 35-40 year old UK woman who is wellness-curious but skeptical of hype.

Tone: Calm, evidence-led, curious, warm. Never preachy or salesy.
Format: Markdown with ## headings (no # H1 - title is separate)
Length: ~1,000-1,200 words
UK Regulatory: No cure claims. Use "research suggests", "may support", "traditionally used for"

Structure:
- Opening hook (no heading)
- 4-6 H2 sections with evidence and mechanisms
- Practical "how to use" section
- Closing paragraph
- Disclaimer

Always ground claims in the evidence provided.`;

  const userPrompt = `Write an article titled: "${title}"

## Research Brief:
${prompt}

## Evidence from Knowledge Base:
${evidence}

Generate the complete article now.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  return response.content[0].text;
}

async function generateSupportingContent(article, title) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Based on this article titled "${title}":

${article}

Generate the following in JSON format:
{
  "claude_tags": "8-14 comma-separated lowercase tags",
  "claude_post_extract": "WordPress excerpt, max 160 characters",
  "Article Keywords": "single SEO keyphrase",
  "Social Media Post": "under 280 characters, conversational",
  "claude_long_social": "5-6 post thread, separated by newlines",
  "claude_avatar_script": "75-100 word video script teaser",
  "claude_image_prompt": "image prompt for 16:9 featured image, Kinfolk aesthetic",
  "categories": ["array of 1-3 from: Natural Remedies, Health, Research, Lifestyle"]
}

Return ONLY valid JSON, no markdown.`
    }],
    system: 'You are a content assistant. Return only valid JSON, no explanation.'
  });

  try {
    let jsonStr = response.content[0].text;
    if (jsonStr.includes('```json')) jsonStr = jsonStr.split('```json')[1].split('```')[0];
    else if (jsonStr.includes('```')) jsonStr = jsonStr.split('```')[1].split('```')[0];
    return JSON.parse(jsonStr.trim());
  } catch (e) {
    console.error('Failed to parse supporting content:', e);
    return {};
  }
}

// ── Airtable Update ────────────────────────────────────────────────────────

async function updateAirtableRecord(recordId, article, supportingContent) {
  return new Promise((resolve, reject) => {
    airtable(CONFIG.airtable.tableId).update(recordId, {
      'written_article': article,
      'claude_tags': supportingContent.claude_tags || '',
      'claude_post_extract': supportingContent.claude_post_extract || '',
      'Article Keywords': supportingContent['Article Keywords'] || '',
      'Social Media Post': supportingContent['Social Media Post'] || '',
      'claude_long_social': supportingContent.claude_long_social || '',
      'claude_avatar_script': supportingContent.claude_avatar_script || '',
      'claude_image_prompt': supportingContent.claude_image_prompt || '',
      'categories': supportingContent.categories || ['Natural Remedies'],
      'article_source_name': 'Plantz News Agent (GitHub Actions)'
      // NOTE: Publication Date is NOT set here. Human sets it during review.
    }, (err, record) => {
      if (err) reject(err);
      else resolve(record);
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Plantz News Agent v3 starting...');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Max articles per run: ${CONFIG.maxArticlesPerRun}\n`);
  
  try {
    const queuedArticles = await getQueuedArticles();
    console.log(`📋 Found ${queuedArticles.length} queued article(s)\n`);
    
    if (queuedArticles.length === 0) {
      console.log('📭 No queued articles. Exiting.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const record of queuedArticles) {
      const title = record.get('article_title');
      const prompt = record.get('prompt');
      
      console.log(`📝 Processing: "${title}"`);
      
      try {
        // Mark as writing
        await updatePipelineStatus(record.id, 'writing');
        console.log('   📌 Status: writing');
        
        // Query Pinecone for evidence
        const searchTerms = `${title} ${prompt}`.substring(0, 500);
        console.log('   🔍 Querying Pinecone...');
        const evidence = await searchPinecone(searchTerms);
        console.log(`   Found ${evidence.length} chars of evidence`);
        
        // Generate article
        console.log('   ✍️  Generating article...');
        const article = await generateArticle(title, prompt, evidence);
        console.log(`   Generated ${article.length} chars`);
        
        // Generate supporting content
        console.log('   📦 Generating supporting content...');
        const supportingContent = await generateSupportingContent(article, title);
        
        // Update Airtable
        console.log('   💾 Updating Airtable...');
        await updateAirtableRecord(record.id, article, supportingContent);
        
        // Mark as review
        await updatePipelineStatus(record.id, 'review');
        console.log('   📌 Status: review');
        
        // Discord notification
        await sendDiscordNotification(
          `**${title}**\n\n` +
          `Ready for review in Airtable.\n` +
          `Categories: ${(supportingContent.categories || []).join(', ')}\n\n` +
          `_Review the article, upload a featured image, set a Publication Date, and tick ☑ post_to_wordpress._`
        );
        
        successCount++;
        console.log(`   ✅ Complete!\n`);
        
      } catch (error) {
        errorCount++;
        console.error(`   ❌ Error: ${error.message}\n`);
        
        // Mark as error
        try {
          await updatePipelineStatus(record.id, 'error');
        } catch (statusErr) {
          console.error(`   ⚠️ Could not update status to error: ${statusErr.message}`);
        }
        
        await sendDiscordNotification(
          `**Error writing:** ${title}\n\`\`\`${error.message}\`\`\``,
          true
        );
      }
    }

    console.log('━'.repeat(50));
    console.log(`🎉 Run complete: ${successCount} written, ${errorCount} errors`);
    
    if (errorCount > 0) {
      console.log('⚠️ Some articles had errors — check Discord for details.');
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    await sendDiscordNotification(`**Fatal error:**\n\`\`\`${error.message}\`\`\``, true);
    process.exit(1);
  }
}

main();

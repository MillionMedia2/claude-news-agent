/**
 * Plantz News Agent - Article Generation Script (v3.4)
 * 
 * v3.4 changes:
 *   - Complete rewrite of system prompt merging:
 *     - Full Aisha persona and tone of voice guide
 *     - UK herbal medicine regulatory compliance (THR/MHRA rules)
 *     - What you can and can't say about natural remedies
 *     - Detailed diction guide (preferred/avoided words)
 *     - Yoast SEO readability targets
 *     - Keyphrase-in-headings guidance
 * 
 * v3.2-3.3 changes:
 *   - Claim ALL queued articles as "writing" UPFRONT (duplicate prevention)
 *   - maxArticlesPerRun: 10
 *
 * Env vars: ANTHROPIC_API_KEY, AIRTABLE_API_KEY, PINECONE_API_KEY,
 *           DISCORD_WEBHOOK_NOTIFICATIONS
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
  maxArticlesPerRun: 10
};

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

// ── Discord ────────────────────────────────────────────────────────────────

async function sendDiscordNotification(message, isError = false) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_NOTIFICATIONS;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: isError ? '❌ Article Generation Error' : '✅ Article Ready for Review',
          description: message,
          color: isError ? 0xFF0000 : 0x58B09C,
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

// ── Claim Articles (Atomic) ────────────────────────────────────────────────

async function claimArticles(records) {
  const claimed = [];
  for (const record of records) {
    try {
      const fresh = await new Promise((resolve, reject) => {
        airtable(CONFIG.airtable.tableId).find(record.id, (err, rec) => 
          err ? reject(err) : resolve(rec)
        );
      });
      if (fresh.get('pipeline_status') !== 'queued') {
        console.log(`   ⏭️  "${record.get('article_title')}" — already claimed, skipping`);
        continue;
      }
      await updatePipelineStatus(record.id, 'writing');
      claimed.push(record);
      console.log(`   🔒 Claimed: "${record.get('article_title')}"`);
    } catch (error) {
      console.error(`   ⚠️ Failed to claim "${record.get('article_title')}": ${error.message}`);
    }
  }
  return claimed;
}

// ── Get Queued Articles ────────────────────────────────────────────────────

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
        sort: [{ field: 'Created', direction: 'asc' }]
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
          query: { topK: 10, inputs: { text: searchText } }
        })
      }
    );
    if (!response.ok) throw new Error(`Pinecone search failed: ${response.status}`);
    const data = await response.json();
    return data.result?.hits?.map(hit => hit.fields?.text || '').join('\n\n---\n\n') || '';
  } catch (error) {
    console.error('Pinecone search error:', error);
    return '';
  }
}

// ── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are 'The Plantz Guide,' a warm, intelligent, and evidence-led article writer for Plantz.io, a UK-based natural health platform. Your goal is to educate, inspire, and build trust — never to sell.

## YOUR AUDIENCE: AISHA, THE WELLNESS EXPLORER

You must write as if speaking directly to Aisha.

Who she is: A UK-based woman, aged 28-40. Educated, digitally savvy, and proactive about her health. She works in a creative or professional field and sees wellness as part of her lifestyle.

Her mindset: She is on a continuous journey of self-improvement. She is curious, intelligent, and a discerning consumer. She is not looking for quick fixes.

Her values:
- Authenticity: She filters out marketing hype instantly.
- Scientific evidence: She respects traditional wisdom but trusts it when validated by modern science.
- Sustainability and ethics: She cares about ingredient sourcing and brand transparency.

Her biggest pain point: She is overwhelmed by "wellness noise" — conflicting advice and unsubstantiated trends. You are her calm, credible signal in that noise.

## CORE COMMUNICATION PRINCIPLES

1. Educate, don't sell. Lead with valuable information. Any product mention is a natural conclusion, not the headline.
2. Be a guide, not a guru. Your tone is collaborative and conversational. You share knowledge with an equal, not preach from a pedestal.
3. Bridge science and soul. Blend scientific evidence with the language of ritual, feeling, and personal experience.
4. Inspire action, not urgency. Encourage her to explore a topic further. Never use aggressive calls-to-action.

## TONE AND DICTION

Tone:
- Calm and reassuring. Your pace is unhurried.
- Curious and intelligent. You sound genuinely fascinated by the subject.
- Warm and empathetic. You understand the pressures of modern life.
- Respectful and humble. You present evidence, not absolute truths.

Preferred words: explore, discover, understand, ritual, intentional, evidence, research suggests, gentle, nourish, support, balance, adapt.

Avoided words: hack, trick, secret, miracle, cure, guaranteed, amazing, instant, detox, must-have, buy now, hurry.

Sentence style:
- Mix shorter, clear sentences for facts with slightly longer ones for mood-setting.
- Use gentle rhetorical questions to engage curiosity (e.g. "Ever wondered why chamomile feels so calming? The science is actually fascinating...").
- Use inclusive language: "We often think about...", "If you're like many of us..."

## UK REGULATORY COMPLIANCE — WHAT YOU CAN AND CAN'T SAY

This section is non-negotiable. Every article must comply with UK herbal medicine law.

WHAT YOU CAN SAY:
- Describe the botanical identity of a herb (e.g. "Devil's Claw (Harpagophytum procumbens) is a plant native to southern Africa.")
- Explain active compounds and their pharmacological properties based on scientific literature (e.g. "Harpagoside has demonstrated anti-inflammatory properties in studies.")
- Discuss traditional uses and historical context without asserting guaranteed efficacy (e.g. "Traditionally, Devil's Claw has been used for joint discomfort.")
- Reference clinical studies using neutral language (e.g. "Some clinical trials suggest that standardised extracts may help reduce joint pain.")
- State when evidence is limited or preliminary (e.g. "More research is needed to confirm these effects.")
- Advise users to consult healthcare professionals before starting supplements.
- Clarify regulatory context where relevant (e.g. "Medicinal claims can only be made for products registered under Traditional Herbal Registration (THR).")

WHAT YOU MUST NEVER SAY:
- Never claim any herb treats, cures, or prevents disease (e.g. "Devil's Claw cures arthritis" is prohibited).
- Never imply guaranteed efficacy (e.g. "Willow Bark is a natural aspirin" as a substitute claim is not allowed).
- Never give personalised medical advice or dosing recommendations (e.g. "Take Devil's Claw for your arthritis" is prohibited).
- Never make health claims about unregistered products.
- Never claim science is "clear" or "proven" unless supported by robust evidence AND regulatory approval.
- Never use language encouraging unapproved or unsafe use.
- Never use: "toxins", "energy fields", "cleanse" (in a pseudoscientific context), or any concept not grounded in verifiable science.

EXAMPLE COMPLIANT PHRASING:
- "Traditional use of Devil's Claw includes relief of joint discomfort."
- "Clinical studies suggest some benefit for joint pain with standardised extracts."
- "Please consult a healthcare professional before using herbal supplements."

EXAMPLE NON-COMPLIANT PHRASING (NEVER USE):
- "Devil's Claw is a natural aspirin and cures inflammation."
- "This product will cure your arthritis pain without fail."
- "Take this herb instead of prescribed medication."

## SEO READABILITY RULES (Yoast Green Score Targets)

These are STRICT requirements — every article MUST meet all of them:

1. ACTIVE VOICE: At least 90% of sentences must use active voice. Passive voice below 10%.
   - BAD: "The compound was found to reduce inflammation."
   - GOOD: "Researchers found that the compound reduces inflammation."

2. SENTENCE LENGTH: At least 75% of sentences must be under 20 words. Target 12-17 words average.
   - Mix short punchy sentences with medium ones. If a sentence has a comma and "and", split it into two.

3. PARAGRAPH LENGTH: Maximum 3-4 sentences per paragraph. Most should be 2-3 sentences.

4. TRANSITION WORDS: At least 30% of sentences must begin with transition words. Use: "however", "for example", "in addition", "as a result", "specifically", "meanwhile", "on the other hand", "that said", "in practice", "interestingly", "importantly".

5. SUBHEADING DISTRIBUTION: Maximum 250-300 words between ## headings. Insert a new ## heading before any section exceeds 300 words.

6. KEYPHRASE IN HEADINGS: Include the primary SEO keyphrase (from the research brief) in 30-75% of ## subheadings. Use it naturally — never force it. Use synonyms or related phrases where needed.

7. FLESCH READING EASE: Target 60-70. Use plain English. If you use a technical term like "adaptogen" or "nootropic", explain it immediately in simple terms.

## HEADING FORMAT
- Use Markdown ## headings (no # H1 — WordPress handles the title separately).
- Maintain logical hierarchy: ## for main sections, ### for subsections if needed. Never skip levels.
- Each heading should be informative and descriptive, not vague teasers.
- Someone scanning only the headings should understand the article's full flow.

## ARTICLE FORMAT
- Markdown with ## headings
- UK English spelling throughout (optimise, colour, recognised, defence, centre)
- Length: 1,000-1,200 words
- Do NOT start the article with the same words as the title

## ARTICLE STRUCTURE
1. Opening hook paragraph (no heading) — 2-3 short sentences that draw the reader in
2. 4-6 ## sections covering evidence, mechanisms, practical guidance
3. A practical "How to Use" or "What to Look For" section near the end
4. Brief closing paragraph
5. Disclaimer in italics: "_This article is for educational purposes only and does not constitute medical advice. Always consult a healthcare professional before starting any new supplement, especially if you have underlying health conditions or take medications._"

## FINAL SELF-CHECK (apply before finishing)
Before outputting, verify:
- Active voice in 90%+ of sentences? (Check every "was", "were", "been", "being")
- 75%+ sentences under 20 words?
- 30%+ sentences start with transition words?
- All paragraphs 4 sentences or fewer?
- A ## heading every 250-300 words or sooner?
- No medicinal claims? No "cures", "treats", "prevents"?
- SEO keyphrase appears in 30-75% of subheadings?
- UK English spelling throughout?
- Does this feel like content from a calm, trusted, intelligent friend?`;

// ── Article Generation ─────────────────────────────────────────────────────

async function generateArticle(title, prompt, evidence) {
  const userPrompt = `Write an article titled: "${title}"

## Research Brief:
${prompt}

## Evidence from Knowledge Base:
${evidence}

STRICT REQUIREMENTS for this article:
- Active voice (90%+), short sentences (75% under 20 words), transition words (30%+)
- Short paragraphs (max 3-4 sentences), ## heading every 250-300 words
- UK regulatory compliant: no cure claims, no medical advice
- UK English spelling
- Include the SEO keyphrase from the research brief in 30-75% of subheadings

Generate the complete article now.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: userPrompt }],
    system: SYSTEM_PROMPT
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
  "Social Media Post": "under 280 characters, conversational, no aggressive CTAs, use Aisha's tone",
  "claude_long_social": "5-6 post thread, separated by newlines, educational not salesy",
  "claude_avatar_script": "75-100 word video script teaser, warm and curious tone",
  "claude_image_prompt": "image prompt for 16:9 featured image, minimalist natural aesthetic, earth tones, Kinfolk magazine feel",
  "categories": ["array of 1-3 from: Natural Remedies, Health, Research, Lifestyle"]
}

Return ONLY valid JSON, no markdown.`
    }],
    system: 'You are a content assistant for Plantz.io. Return only valid JSON, no explanation. Match the warm, evidence-led Aisha tone in social content. Never use aggressive CTAs or hype language.'
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
    }, (err, record) => {
      if (err) reject(err);
      else resolve(record);
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Plantz News Agent v3.4 starting...');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Max articles per run: ${CONFIG.maxArticlesPerRun}\n`);
  
  try {
    const queuedArticles = await getQueuedArticles();
    console.log(`📋 Found ${queuedArticles.length} queued article(s)`);
    
    if (queuedArticles.length === 0) {
      console.log('📭 No queued articles. Exiting.');
      return;
    }

    console.log('\n🔒 Claiming articles...');
    const claimedArticles = await claimArticles(queuedArticles);
    console.log(`   Claimed ${claimedArticles.length} of ${queuedArticles.length}\n`);
    
    if (claimedArticles.length === 0) {
      console.log('📭 All articles already claimed by another run. Exiting.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const record of claimedArticles) {
      const title = record.get('article_title');
      const prompt = record.get('prompt');
      
      console.log(`📝 Processing: "${title}"`);
      
      try {
        const searchTerms = `${title} ${prompt}`.substring(0, 500);
        console.log('   🔍 Querying Pinecone...');
        const evidence = await searchPinecone(searchTerms);
        console.log(`   Found ${evidence.length} chars of evidence`);
        
        console.log('   ✍️  Generating article...');
        const article = await generateArticle(title, prompt, evidence);
        console.log(`   Generated ${article.length} chars`);
        
        console.log('   📦 Generating supporting content...');
        const supportingContent = await generateSupportingContent(article, title);
        
        console.log('   💾 Updating Airtable...');
        await updateAirtableRecord(record.id, article, supportingContent);
        
        await updatePipelineStatus(record.id, 'review');
        console.log('   📌 Status: review');
        
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

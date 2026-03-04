/**
 * Plantz News Agent - Headline Generation Script (v1.0)
 *
 * Runs every Monday at 6am UTC. Generates 10 article headlines
 * with full writing prompts and creates them in the Headline Queue
 * with status: "draft" for human review.
 *
 * The script:
 * 1. Checks it's Monday (skips otherwise, unless --force)
 * 2. Checks for existing draft headlines (skips if 5+ unreviewed)
 * 3. Queries Pinecone for available herb/supplement topics
 * 4. Fetches recently published subjects to avoid repetition
 * 5. Calls Claude to generate 10 headlines with full article prompts
 * 6. Creates records in Headline Queue with status: "draft"
 * 7. Sends Discord notification
 *
 * Env vars (must match .env naming):
 *   ANTHROPIC_API_KEY, AIRTABLE_API_KEY, PINECONE_API_KEY,
 *   DISCORD_WEBHOOK_NOTIFICATIONS
 */

import Anthropic from '@anthropic-ai/sdk';
import Airtable from 'airtable';

// Configuration
const CONFIG = {
  airtable: {
    baseId: 'appN9kmTgJbjel4J1',
    headlineTable: 'tbl00YTHfrVnKQQai',
    articlesTable: 'tblUhbxC3LIKgORLa'
  },
  pinecone: {
    host: 'https://plantz1-aokppsg.svc.gcp-europe-west4-de1d.pinecone.io',
    namespace: 'herb_monographs'
  },
  headlinesToGenerate: 10,
  maxDraftsBeforeSkip: 5
};

const FORCE = process.argv.includes('--force');

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);

// ── Monday Check ───────────────────────────────────────────────────────────

function isMonday() {
  return new Date().getUTCDay() === 1;
}

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
          title: isError ? '❌ Headline Generation Error' : '📋 New Headlines Ready for Review',
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

// ── Airtable Queries ───────────────────────────────────────────────────────

async function getDraftHeadlineCount() {
  return new Promise((resolve, reject) => {
    let count = 0;
    airtable(CONFIG.airtable.headlineTable)
      .select({
        filterByFormula: '{status} = "draft"',
        fields: ['headline']
      })
      .eachPage(
        (records, next) => { count += records.length; next(); },
        (err) => err ? reject(err) : resolve(count)
      );
  });
}

async function getRecentSubjects(limit = 30) {
  return new Promise((resolve, reject) => {
    const subjects = [];
    airtable(CONFIG.airtable.articlesTable)
      .select({
        maxRecords: limit,
        fields: ['subject', 'article_title', 'angle'],
        sort: [{ field: 'Created', direction: 'desc' }]
      })
      .eachPage(
        (records, next) => {
          records.forEach(r => {
            const subj = r.get('subject');
            if (subj) subjects.push({
              subject: subj,
              title: r.get('article_title') || '',
              angle: r.get('angle') || ''
            });
          });
          next();
        },
        (err) => err ? reject(err) : resolve(subjects)
      );
  });
}

async function getRecentHeadlineSubjects(limit = 30) {
  return new Promise((resolve, reject) => {
    const subjects = [];
    airtable(CONFIG.airtable.headlineTable)
      .select({
        maxRecords: limit,
        fields: ['subject', 'headline'],
        sort: [{ field: 'Last Modified', direction: 'desc' }]
      })
      .eachPage(
        (records, next) => {
          records.forEach(r => {
            const subj = r.get('subject');
            if (subj) subjects.push(subj);
          });
          next();
        },
        (err) => err ? reject(err) : resolve(subjects)
      );
  });
}

// ── Pinecone: Discover Topics ──────────────────────────────────────────────

async function discoverTopics(searchQueries) {
  const topics = new Set();
  
  for (const query of searchQueries) {
    try {
      const response = await fetch(
        `${CONFIG.pinecone.host}/records/namespaces/${CONFIG.pinecone.namespace}/search`,
        {
          method: 'POST',
          headers: {
            'Api-Key': process.env.PINECONE_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: { topK: 5, inputs: { text: query } }
          })
        }
      );

      if (!response.ok) continue;

      const data = await response.json();
      const hits = data.result?.hits || [];
      hits.forEach(hit => {
        const text = hit.fields?.text || '';
        if (text.length > 20) {
          topics.add(text.substring(0, 200));
        }
      });
    } catch (error) {
      console.error(`Pinecone search error for "${query}":`, error.message);
    }
  }

  return [...topics];
}

// ── Claude: Generate Headlines ─────────────────────────────────────────────

async function generateHeadlines(recentSubjects, evidenceSnippets) {
  const recentList = recentSubjects.map(s => 
    `- ${s.subject} (angle: ${s.angle}, title: ${s.title})`
  ).join('\n');

  const recentSubjectNames = [...new Set(recentSubjects.map(s => s.subject))].join(', ');

  const evidenceContext = evidenceSnippets.length > 0 
    ? `\n\nHere are some evidence snippets from our knowledge base to inspire topics:\n${evidenceSnippets.slice(0, 5).join('\n---\n')}`
    : '';

  const systemPrompt = `You are the Plantz editorial planner. You generate article headlines and writing briefs for a UK-based natural health platform targeting Aisha — a wellness-curious, evidence-minded woman aged 28-40.

Content principles:
- Evidence-based, never preachy or salesy
- Lead with mechanisms ("here's WHY it works"), not claims ("you should try this")
- UK regulatory compliant: no cure claims, use "research suggests", "may support", "traditionally used for"
- Topics: herbs, supplements, functional mushrooms, traditional remedies, teas, adaptogens, vitamins, minerals, gut health, sleep, stress
- Tone: warm, curious, calm. Think "informed friend" not "health guru"
- SEO-aware: headlines should target searchable queries

You must return ONLY valid JSON — no markdown, no explanation, no preamble.`;

  const userPrompt = `Generate exactly 10 article headlines for this week's content batch.

RECENTLY COVERED SUBJECTS (avoid repeating these):
${recentList || '(none yet)'}

Subjects to avoid: ${recentSubjectNames || 'none'}
${evidenceContext}

For each headline, provide a complete writing brief. Return a JSON array of exactly 10 objects:

[
  {
    "headline": "The full article title, SEO-optimised, compelling for Aisha",
    "subject": "Single herb/supplement/topic name (e.g. Ashwagandha, Magnesium, Lion's Mane)",
    "angle": "One of: deep_dive, safety_deep_dive, comparison, myth_busting, seasonal, mechanism_explainer, beginners_guide, research_roundup",
    "seo_keyword": "Primary search term to target (e.g. 'ashwagandha benefits for stress')",
    "article_prompt": "TOPIC: [Subject] — [Brief description of the article's purpose]\\nANGLE: [angle] — [What this angle means for the article structure]\\nPRIMARY SEO KEYWORD: [keyword]\\nKEY POINTS TO COVER:\\n- [Point 1]\\n- [Point 2]\\n- [Point 3]\\n- [Point 4]\\n- [Point 5]\\n- [Point 6]\\nEVIDENCE TO QUERY:\\n- Search Pinecone (herb_monographs namespace) for: '[search term 1]', '[search term 2]', '[search term 3]', '[search term 4]'\\n- Look for: [what kind of evidence to find]",
    "target_word_count": 1000,
    "priority_order": 1
  }
]

Requirements:
- All 10 must have DIFFERENT subjects
- Mix of angles (at least 3 different angle types)
- priority_order from 1 (most important) to 10
- article_prompt must be detailed enough for another AI to write the full article
- Each seo_keyword should be a realistic search query people actually type`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  let jsonStr = response.content[0].text;
  if (jsonStr.includes('```json')) jsonStr = jsonStr.split('```json')[1].split('```')[0];
  else if (jsonStr.includes('```')) jsonStr = jsonStr.split('```')[1].split('```')[0];
  
  return JSON.parse(jsonStr.trim());
}

// ── Airtable: Create Headlines ─────────────────────────────────────────────

async function createHeadlines(headlines) {
  const batchId = `batch-${new Date().toISOString().split('T')[0]}`;
  const created = [];

  for (let i = 0; i < headlines.length; i += 10) {
    const batch = headlines.slice(i, i + 10);
    const records = batch.map(h => ({
      fields: {
        headline: h.headline,
        subject: h.subject,
        angle: h.angle,
        seo_keyword: h.seo_keyword,
        article_prompt: h.article_prompt,
        target_word_count: h.target_word_count || 1000,
        priority_order: h.priority_order || 1,
        batch_id: batchId,
        status: 'draft'
      }
    }));

    const response = await new Promise((resolve, reject) => {
      airtable(CONFIG.airtable.headlineTable).create(
        records.map(r => r),
        { typecast: true },
        (err, records) => err ? reject(err) : resolve(records)
      );
    });

    created.push(...response);
  }

  return created;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📋 Plantz Headline Generator v1.0');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Day: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getUTCDay()]}`);

  // Monday check
  if (!isMonday() && !FORCE) {
    console.log('Not Monday — skipping headline generation.');
    console.log('Use --force to override.');
    return;
  }

  if (FORCE && !isMonday()) {
    console.log('⚠️ Force mode — running despite not being Monday');
  }

  try {
    // Check for existing drafts
    console.log('\n🔍 Checking existing draft headlines...');
    const draftCount = await getDraftHeadlineCount();
    console.log(`   ${draftCount} unreviewed drafts in queue`);

    if (draftCount >= CONFIG.maxDraftsBeforeSkip && !FORCE) {
      console.log(`   ⚠️ ${draftCount} drafts already pending — skipping generation.`);
      console.log('   Review existing headlines before generating new ones.');
      await sendDiscordNotification(
        `**Headline generation skipped** — ${draftCount} unreviewed drafts already in queue.\n\nReview and approve existing headlines before new ones are generated.`
      );
      return;
    }

    // Get recent subjects to avoid repetition
    console.log('\n📚 Fetching recent subjects...');
    const recentArticleSubjects = await getRecentSubjects();
    const recentHeadlineSubjects = await getRecentHeadlineSubjects();
    console.log(`   ${recentArticleSubjects.length} recent articles, ${recentHeadlineSubjects.length} recent headlines`);

    // Query Pinecone for topic inspiration
    console.log('\n🔍 Querying Pinecone for topic ideas...');
    const searchQueries = [
      'popular herbal supplements benefits',
      'adaptogen stress anxiety research',
      'functional mushrooms immune health',
      'vitamins minerals deficiency UK',
      'gut health probiotics microbiome',
      'sleep natural remedies melatonin',
      'anti-inflammatory herbs turmeric',
      'traditional medicine evidence based'
    ];
    const evidenceSnippets = await discoverTopics(searchQueries);
    console.log(`   Found ${evidenceSnippets.length} evidence snippets`);

    // Generate headlines with Claude
    console.log('\n✍️ Generating 10 headlines with Claude...');
    const headlines = await generateHeadlines(recentArticleSubjects, evidenceSnippets);
    
    if (!Array.isArray(headlines) || headlines.length === 0) {
      throw new Error('Claude returned invalid or empty headlines array');
    }
    
    console.log(`   Generated ${headlines.length} headlines:`);
    headlines.forEach((h, i) => {
      console.log(`   ${i + 1}. ${h.headline}`);
      console.log(`      Subject: ${h.subject} | Angle: ${h.angle}`);
    });

    // Create in Airtable
    console.log('\n💾 Creating headline records in Airtable...');
    const created = await createHeadlines(headlines);
    console.log(`   ✅ Created ${created.length} headline records`);

    // Discord notification
    const headlineList = headlines.map((h, i) => 
      `${i + 1}. **${h.headline}**\n   _${h.subject} · ${h.angle}_`
    ).join('\n');

    await sendDiscordNotification(
      `**${created.length} new headlines generated for this week:**\n\n${headlineList}\n\n_Review in Airtable → Headline Queue, then set status to "approved" for the ones you want written._`
    );

    console.log('\n' + '━'.repeat(50));
    console.log(`🎉 Done! ${created.length} headlines ready for review.`);

  } catch (error) {
    console.error('Fatal error:', error);
    await sendDiscordNotification(
      `**Headline generation failed:**\n\`\`\`${error.message}\`\`\``,
      true
    );
    process.exit(1);
  }
}

main();

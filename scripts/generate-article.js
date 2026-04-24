/**
 * Plantz News Agent - Article Generation Script (v4.0)
 *
 * v4.0 changes:
 *   - Namespace routing: evidence is now pulled from the SPECIFIC Pinecone
 *     namespace(s) appropriate to the article's angle (read from Airtable
 *     fields `pinecone_namespaces` if present, otherwise inferred from angle).
 *   - Multi-namespace evidence: articles that blend cannabis + herbs (e.g.
 *     women's health) now pull from both relevant namespaces.
 *   - Persona-aware system prompts: writer tone switches between Aisha
 *     (herbs/wellness), Chloe (FAQ/new cannabis patient), David (device
 *     buying-intent, deep cannabis science), and Dr Carter (clinical).
 *   - Expanded angle handling for: cannabis_condition, faq_deep_dive,
 *     buying_intent_device, womens_health, plus legacy angles.
 *   - Honours the Women's Circle quote placeholder — if the prompt contains
 *     [WOMENS_CIRCLE_QUOTE_PLACEHOLDER: ...], the article is written with
 *     a visible [QUOTE TBC: ...] marker that editorial can fill in.
 *
 * v3.4 legacy: full Aisha persona + UK regulatory compliance + Yoast targets.
 * v3.2–3.3: claim-first duplicate prevention retained.
 *
 * Env vars: ANTHROPIC_API_KEY, AIRTABLE_API_KEY, PINECONE_API_KEY,
 *           DISCORD_WEBHOOK_NOTIFICATIONS
 */

import Anthropic from '@anthropic-ai/sdk';
import Airtable from 'airtable';

// Configuration
const CONFIG = {
  airtable: {
    baseId: 'appN9kmTgJbjel4J1',
    tableId: 'Articles'
  },
  pinecone: {
    host: 'https://plantz1-aokppsg.svc.gcp-europe-west4-de1d.pinecone.io',
    // Namespaces available in the plantz1 index
    namespaces: {
      products:       'plantz-products',
      herbs:          'herb_monographs',
      cannabisFaq:    'cannabis_faq',
      cannabis:       'cannabis',
      cannabisProd:   'cannabis_products',
      naturalRem:     'natural_remedies'
    }
  },
  maxArticlesPerRun: 10
};

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(CONFIG.airtable.baseId);

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

// ── Angle → Namespace Routing ──────────────────────────────────────────────

/**
 * Map an article's angle to the Pinecone namespaces that hold the most
 * relevant evidence. Returns an array of namespace strings.
 */
function namespacesForAngle(angle) {
  const ns = CONFIG.pinecone.namespaces;
  switch (angle) {
    case 'product_deep_dive':
      return [ns.products, ns.herbs, ns.naturalRem];
    case 'cannabis_condition':
      return [ns.cannabis, ns.cannabisFaq, ns.cannabisProd];
    case 'faq_deep_dive':
      return [ns.cannabisFaq, ns.cannabis];
    case 'womens_health':
      // Blend both worlds — cannabis + herbal + broad natural remedies
      return [ns.cannabis, ns.naturalRem, ns.herbs, ns.cannabisFaq];
    case 'buying_intent_device':
      return [ns.products, ns.cannabisProd];
    case 'research_roundup':
    case 'mechanism_explainer':
    case 'myth_busting':
      return [ns.herbs, ns.naturalRem, ns.cannabis];
    case 'industry_story':
      return [ns.cannabis, ns.cannabisFaq];
    case 'seasonal':
    case 'beginners_guide':
    case 'safety_deep_dive':
    case 'comparison':
    case 'deep_dive':
    default:
      return [ns.herbs, ns.naturalRem, ns.products];
  }
}

// ── Pinecone Search ────────────────────────────────────────────────────────

async function searchNamespace(namespace, searchText, topK = 8) {
  try {
    const response = await fetch(
      `${CONFIG.pinecone.host}/records/namespaces/${namespace}/search`,
      {
        method: 'POST',
        headers: {
          'Api-Key': process.env.PINECONE_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: { topK, inputs: { text: searchText } }
        })
      }
    );
    if (!response.ok) {
      console.error(`   ⚠️ Pinecone ${namespace} search failed: ${response.status}`);
      return [];
    }
    const data = await response.json();
    return data.result?.hits || [];
  } catch (error) {
    console.error(`   ⚠️ Pinecone ${namespace} error:`, error.message);
    return [];
  }
}

/**
 * Build an evidence block by querying multiple namespaces. If the Airtable
 * record carried explicit pinecone_namespaces and pinecone_queries (from the
 * v2.0 headline generator), use those. Otherwise fall back to angle routing
 * and a generic title+prompt query.
 */
async function gatherEvidence(record) {
  const title = record.get('article_title') || '';
  const prompt = record.get('prompt') || '';
  const angle = record.get('angle') || '';
  const subject = record.get('subject') || '';

  // Prefer explicit namespace instructions from the headline brief
  let namespaces = [];
  const explicitNs = record.get('pinecone_namespaces');
  if (explicitNs) {
    // Airtable may store as string or array; handle both
    namespaces = Array.isArray(explicitNs)
      ? explicitNs
      : String(explicitNs).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (namespaces.length === 0) {
    namespaces = namespacesForAngle(angle);
  }
  // Dedupe
  namespaces = [...new Set(namespaces)];

  // Prefer explicit queries; otherwise derive from title/subject/prompt
  let queries = [];
  const explicitQueries = record.get('pinecone_queries');
  if (explicitQueries) {
    queries = Array.isArray(explicitQueries)
      ? explicitQueries
      : String(explicitQueries).split('\n').map(s => s.trim()).filter(Boolean);
  }
  if (queries.length === 0) {
    const primary = `${subject} ${title}`.substring(0, 200).trim();
    const secondary = prompt.substring(0, 300).trim();
    queries = [primary, secondary].filter(Boolean);
  }

  console.log(`   📚 Querying ${namespaces.length} namespace(s) with ${queries.length} query/queries`);

  const blocks = [];
  const seenTexts = new Set();

  for (const ns of namespaces) {
    for (const q of queries) {
      const hits = await searchNamespace(ns, q, 5);
      for (const hit of hits) {
        const text = hit.fields?.text
          || hit.fields?.answer_summary
          || hit.fields?.question
          || '';
        if (!text || text.length < 40) continue;
        const key = text.substring(0, 100);
        if (seenTexts.has(key)) continue;
        seenTexts.add(key);
        blocks.push(`[${ns}] ${text.substring(0, 800)}`);
        if (blocks.length >= 18) break;
      }
      if (blocks.length >= 18) break;
    }
    if (blocks.length >= 18) break;
  }

  return {
    evidence: blocks.join('\n\n---\n\n'),
    namespacesUsed: namespaces,
    chunkCount: blocks.length
  };
}

// ── System Prompts (Persona-aware) ─────────────────────────────────────────

const AISHA_PERSONA_BLOCK = `## YOUR AUDIENCE: AISHA, THE WELLNESS EXPLORER

You must write as if speaking directly to Aisha.

Who she is: A UK-based woman, aged 28–40. Educated, digitally savvy, and proactive about her health. She works in a creative or professional field and sees wellness as part of her lifestyle.

Her mindset: She is on a continuous journey of self-improvement. She is curious, intelligent, and a discerning consumer. She is not looking for quick fixes.

Her values:
- Authenticity: She filters out marketing hype instantly.
- Scientific evidence: She respects traditional wisdom but trusts it when validated by modern science.
- Sustainability and ethics: She cares about ingredient sourcing and brand transparency.

Her biggest pain point: She is overwhelmed by "wellness noise" — conflicting advice and unsubstantiated trends. You are her calm, credible signal in that noise.`;

const CHLOE_PERSONA_BLOCK = `## YOUR AUDIENCE: CHLOE, THE ANXIOUS NEWCOMER

You must write as if speaking directly to Chloe.

Who she is: 32, struggling with chronic migraines and anxiety. Curious about medical cannabis but intimidated by the stigma, legal complexity, and fear of being judged. She has never been to a cannabis clinic.

Her mindset: She needs calm reassurance, not enthusiasm. She's worried about side effects, her employer, her family finding out, and whether it's "really legal." She finds most cannabis content either too technical or too salesy.

Her values:
- Clarity: plain English over jargon, every time.
- Safety: she wants to know the risks before the benefits.
- Legitimacy: she needs to know this is a proper medical pathway, not a loophole.

Tone for Chloe: gentle, factual, never evangelical. Explain acronyms on first use. Acknowledge her likely fears before answering.`;

const DAVID_PERSONA_BLOCK = `## YOUR AUDIENCE: DAVID, THE EMPOWERED EXPERT

You must write as if speaking directly to David.

Who he is: 45, chronic pain patient, engineer by trade. Active on Reddit and X, reads primary literature, already has a cannabis prescription, and is deep in the terpene/cannabinoid-ratio world. Owns multiple vaporisers.

His mindset: He wants specifics, not generalisations. Temperature ranges, isolation versus convection, PK/PD, cohort sizes. He will call out vagueness. He values tools that respect his intelligence.

His values:
- Depth over breadth.
- Precision: exact numbers, real studies, named compounds.
- Autonomy: he's capable of making his own decisions with the right data.

Tone for David: confident, technical, precise. Don't over-explain basics. Link mechanism to practical choice.`;

const CARTER_PERSONA_BLOCK = `## YOUR AUDIENCE: DR BEN CARTER, THE PROGRESSIVE CLINICIAN

You must write as if speaking directly to a UK private-practice doctor.

Who he is: 52, pain clinic lead, time-poor, ethically cautious. Wants peer-reviewed evidence and clinical decision tools, not patient advocacy content.

Tone for Dr Carter: professional, evidence-forward, concise. Use clinical terminology accurately. Cite study designs (RCT, cohort, meta-analysis) and sample sizes where known. Address real prescribing questions: titration, interactions, adverse events, patient selection.`;

const SHARED_BRAND_BLOCK = `## CORE COMMUNICATION PRINCIPLES

1. Educate, don't sell. Lead with valuable information. Any product mention is a natural conclusion, not the headline.
2. Be a guide, not a guru. Your tone is collaborative and conversational. You share knowledge with an equal, not preach from a pedestal.
3. Bridge science and soul where appropriate. Blend scientific evidence with the language of ritual, feeling, and personal experience — but never at the expense of accuracy.
4. Inspire action, not urgency. Encourage exploration. Never use aggressive calls-to-action.

## PREFERRED / AVOIDED WORDS

Preferred: explore, discover, understand, ritual, intentional, evidence, research suggests, gentle, nourish, support, balance, adapt.
Avoided: hack, trick, secret, miracle, cure, guaranteed, amazing, instant, detox, must-have, buy now, hurry.`;

const UK_COMPLIANCE_BLOCK = `## UK REGULATORY COMPLIANCE — NON-NEGOTIABLE

Every article must comply with UK herbal medicine AND medical cannabis law.

HERBAL / SUPPLEMENT CONTENT:
WHAT YOU CAN SAY:
- Describe the botanical identity of a herb (e.g. "Devil's Claw (Harpagophytum procumbens) is a plant native to southern Africa.")
- Explain active compounds and pharmacological properties based on scientific literature.
- Discuss traditional uses ("Traditionally, Devil's Claw has been used for joint discomfort.")
- Reference clinical studies neutrally ("Some clinical trials suggest…")
- State when evidence is limited or preliminary.
- Advise consultation with healthcare professionals.
- Clarify regulatory context (e.g. THR / novel food / food supplement status).

WHAT YOU MUST NEVER SAY:
- Never claim any herb treats, cures, or prevents disease.
- Never imply guaranteed efficacy.
- Never give personalised medical advice or dosing recommendations.
- Never make health claims about unregistered products.
- Never use "toxins", "energy fields", or pseudoscientific "cleanse" framing.

MEDICAL CANNABIS CONTENT:
WHAT YOU CAN SAY:
- Cannabis is legal in the UK ONLY via private prescription from a doctor on the GMC Specialist Register.
- Reference Schedule 2 of the Misuse of Drugs Regulations 2001.
- Discuss the endocannabinoid system, cannabinoids (THC, CBD, CBG, CBN), terpenes, and the entourage effect on a scientific basis.
- Summarise evidence from named studies (e.g. Project Twenty21, MS GWPharma trials, CB1/CB2 research).
- Describe routes of administration (oil, flower via vaporiser, capsules) factually.

WHAT YOU MUST NEVER SAY:
- Never imply recreational use is legal or endorsed.
- Never recommend a specific strain, cultivar, or product to an individual as medical advice.
- Never encourage self-medication or obtaining cannabis outside a prescription.
- Never claim cannabis cures any condition — use "research suggests it may help manage…"
- Never advise patients to stop prescribed medications.

DEVICE / HARDWARE CONTENT:
- Always frame vaporisers in the context of LEGAL, PRESCRIBED medical cannabis flower.
- Do not glamourise. Focus on clinical dosing, temperature control, and patient experience.
- Never reference combustion/smoking as equivalent alternatives.`;

const YOAST_BLOCK = `## SEO READABILITY RULES (Yoast Green Score Targets)

These are STRICT requirements — every article MUST meet all of them:

1. ACTIVE VOICE: At least 90% of sentences must use active voice. Passive voice below 10%.
2. SENTENCE LENGTH: At least 75% of sentences must be under 20 words. Target 12–17 words average.
3. PARAGRAPH LENGTH: Maximum 3–4 sentences per paragraph.
4. TRANSITION WORDS: At least 30% of sentences must begin with transition words. Use: "however", "for example", "in addition", "as a result", "specifically", "meanwhile", "on the other hand", "that said", "in practice", "interestingly", "importantly".
5. SUBHEADING DISTRIBUTION: Maximum 250–300 words between ## headings.
6. KEYPHRASE IN HEADINGS: Include the primary SEO keyphrase in 30–75% of ## subheadings. Natural use only.
7. FLESCH READING EASE: Target 60–70. Plain English. Explain technical terms on first use.

## HEADING FORMAT
- Use Markdown ## headings (no # H1 — WordPress handles the title separately).
- Maintain logical hierarchy: ## then ### if needed. Never skip levels.

## ARTICLE FORMAT
- Markdown with ## headings.
- UK English spelling throughout (optimise, colour, recognised, defence, centre).
- Length: 1,000–1,200 words unless the brief specifies otherwise.
- Do NOT start the article with the same words as the title.

## STANDARD STRUCTURE
1. Opening hook paragraph (no heading) — 2–3 short sentences
2. 4–6 ## sections covering evidence, mechanisms, practical guidance
3. A practical "How to Use" or "What to Look For" section near the end
4. Brief closing paragraph
5. Disclaimer in italics: "_This article is for educational purposes only and does not constitute medical advice. Always consult a healthcare professional before starting any new supplement or medication, especially if you have underlying health conditions._"`;

const WOMENS_CIRCLE_BLOCK = `## WOMEN'S CIRCLE QUOTE PLACEHOLDER HANDLING

If the research brief contains a line formatted like:
  [WOMENS_CIRCLE_QUOTE_PLACEHOLDER: search Plantz Women's Circle video transcripts for a quote on {topic}]

The Women's Circle video transcript corpus is not yet available to you. You MUST:
1. Preserve the hook by inserting a visible editorial marker at the natural quote location.
2. Format it as a blockquote:
   > [QUOTE TBC — insert a Women's Circle quote on {topic} here; editorial to source from video transcripts before publication]
3. Write the surrounding paragraph so it still reads well if the quote were removed — the quote should enhance the point, not carry it.

This marker will be spotted in review and replaced manually (or by a later retrieval step once transcripts are ingested).`;

const FINAL_CHECK_BLOCK = `## FINAL SELF-CHECK (apply before finishing)

Before outputting, verify:
- Active voice in 90%+ of sentences? (Check every "was", "were", "been", "being")
- 75%+ sentences under 20 words?
- 30%+ sentences start with transition words?
- All paragraphs 4 sentences or fewer?
- A ## heading every 250–300 words or sooner?
- No medicinal claims? No "cures", "treats", "prevents"?
- SEO keyphrase appears in 30–75% of subheadings?
- UK English spelling throughout?
- If the brief contained a Women's Circle placeholder, is the [QUOTE TBC — …] marker in place?
- Does this feel authentic to the target persona?`;

/**
 * Build the persona block string for a given persona key.
 */
function personaBlock(personaKey) {
  switch ((personaKey || '').toLowerCase()) {
    case 'chloe':     return CHLOE_PERSONA_BLOCK;
    case 'david':     return DAVID_PERSONA_BLOCK;
    case 'dr_carter':
    case 'carter':    return CARTER_PERSONA_BLOCK;
    case 'aisha':
    default:          return AISHA_PERSONA_BLOCK;
  }
}

/**
 * Build the full system prompt for a given article.
 */
function buildSystemPrompt(persona, angle) {
  const anglePrefix = (() => {
    switch (angle) {
      case 'buying_intent_device':
        return `You are writing a BUYING-INTENT device article. Structure as a buyer's guide, comparison, or how-to. Include comparison tables in markdown where useful. Be specific: temperature ranges, battery life, chamber size, who it's for, who it's NOT for. End with a clear verdict, not a generic CTA. Always frame in the context of legal, prescribed medical cannabis flower.`;
      case 'cannabis_condition':
        return `You are writing a CANNABIS + CONDITION article. Open with a scene or stat about the condition's prevalence or under-treatment. Explain the endocannabinoid system's role. Summarise the evidence honestly — including its limits. Cover cannabinoid profiles and terpenes most studied for the condition. UK legal framing throughout: private prescription, Schedule 2, Specialist Register doctors only.`;
      case 'faq_deep_dive':
        return `You are EXPANDING A SINGLE FAQ into a deep-dive article. Quote the original question in section 1. Give a 2–3 sentence TL;DR answer. Then go 800+ words deeper — history, nuance, exceptions, edge cases. Link to 2–3 related FAQs by topic at the end.`;
      case 'womens_health':
        return `You are writing a WOMEN'S HEALTH article. Frame the condition with empathy, never infantilising. Cite UK-specific prevalence data where possible. Cover both herbal/supplement AND cannabis approaches where relevant to the condition. Respect the reader's agency — avoid medicalising every cycle symptom. Include a clear note on when to see a GP or specialist.`;
      case 'product_deep_dive':
        return `You are writing a PRODUCT DEEP-DIVE on a herb/supplement we stock. Lead with mechanism, not claims. Cite 2–3 specific studies where the evidence grade supports it. Include a "what to look for" section covering standardisation, dose, and format. End with a natural mention of the product we stock (brand + format) — not a hard sell.`;
      default:
        return '';
    }
  })();

  return [
    `You are 'The Plantz Guide,' an evidence-led article writer for Plantz.io, a UK-based natural health platform covering herbal medicine, supplements, and medical cannabis.`,
    anglePrefix,
    personaBlock(persona),
    SHARED_BRAND_BLOCK,
    UK_COMPLIANCE_BLOCK,
    YOAST_BLOCK,
    WOMENS_CIRCLE_BLOCK,
    FINAL_CHECK_BLOCK
  ].filter(Boolean).join('\n\n');
}

// ── Article Generation ─────────────────────────────────────────────────────

async function generateArticle({ title, prompt, evidence, persona, angle }) {
  const systemPrompt = buildSystemPrompt(persona, angle);

  const userPrompt = `Write an article titled: "${title}"

## Research Brief:
${prompt}

## Evidence from Knowledge Base:
${evidence || '(no evidence retrieved — rely on the research brief and write conservatively)'}

STRICT REQUIREMENTS for this article:
- Active voice (90%+), short sentences (75% under 20 words), transition words (30%+)
- Short paragraphs (max 3–4 sentences), ## heading every 250–300 words
- UK regulatory compliant: no cure claims, no medical advice
- UK English spelling
- Include the SEO keyphrase from the research brief in 30–75% of subheadings
- Target persona: ${persona || 'aisha'}
- Angle: ${angle || 'general'}

Generate the complete article now.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt
  });

  return response.content[0].text;
}

async function generateSupportingContent(article, title, persona, angle) {
  const personaNote = (persona === 'david' || persona === 'dr_carter' || persona === 'carter')
    ? 'Technical and precise; match the expert audience.'
    : persona === 'chloe'
    ? 'Warm, reassuring, plain-English.'
    : 'Warm, evidence-led Aisha tone.';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Based on this article titled "${title}" (angle: ${angle || 'general'}, persona: ${persona || 'aisha'}):

${article}

Generate the following in JSON format:
{
  "claude_tags": "8-14 comma-separated lowercase tags",
  "claude_post_extract": "WordPress excerpt, max 160 characters",
  "Article Keywords": "single SEO keyphrase",
  "Social Media Post": "under 280 characters, conversational, no aggressive CTAs",
  "claude_long_social": "5-6 post thread, separated by newlines, educational not salesy",
  "claude_avatar_script": "75-100 word video script teaser, tone-matched to persona",
  "claude_image_prompt": "image prompt for 16:9 featured image. For herbal/wellness content use: minimalist natural aesthetic, earth tones, Kinfolk magazine feel. For cannabis/clinical content use: clean, clinical, premium, blue/green palette. For device content use: clean product photography, neutral background.",
  "categories": ["array of 1-3 from: Natural Remedies, Health, Research, Lifestyle, Medical Cannabis, Women's Health, Devices"]
}

Tone: ${personaNote}

Return ONLY valid JSON, no markdown.`
    }],
    system: 'You are a content assistant for Plantz.io. Return only valid JSON, no explanation. Never use aggressive CTAs or hype language.'
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
  console.log('🚀 Plantz News Agent v4.0 starting...');
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
      const angle = record.get('angle') || '';
      const persona = (record.get('persona') || '').toLowerCase();

      console.log(`📝 Processing: "${title}"`);
      console.log(`   Angle: ${angle || '(none)'} | Persona: ${persona || '(default aisha)'}`);

      try {
        console.log('   🔍 Gathering evidence...');
        const { evidence, namespacesUsed, chunkCount } = await gatherEvidence(record);
        console.log(`   Retrieved ${chunkCount} chunks from [${namespacesUsed.join(', ')}]`);

        console.log('   ✍️  Generating article...');
        const article = await generateArticle({ title, prompt, evidence, persona, angle });
        console.log(`   Generated ${article.length} chars`);

        console.log('   📦 Generating supporting content...');
        const supportingContent = await generateSupportingContent(article, title, persona, angle);

        console.log('   💾 Updating Airtable...');
        await updateAirtableRecord(record.id, article, supportingContent);

        await updatePipelineStatus(record.id, 'review');
        console.log('   📌 Status: review');

        await sendDiscordNotification(
          `**${title}**\n\n` +
          `Angle: ${angle || 'general'} | Persona: ${persona || 'aisha'}\n` +
          `Evidence: ${chunkCount} chunks from ${namespacesUsed.length} namespace(s)\n` +
          `Categories: ${(supportingContent.categories || []).join(', ')}\n\n` +
          `_Review in Airtable, upload a featured image, set a Publication Date, and tick ☑ post_to_wordpress._`
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

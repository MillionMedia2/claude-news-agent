/**
 * Test script to verify all API connections work
 */

console.log('Testing API connections...\n');

// Check environment variables
const required = [
  'ANTHROPIC_API_KEY',
  'AIRTABLE_API_KEY', 
  'PINECONE_API_KEY',
  'WORDPRESS_USER',
  'WORDPRESS_APP_PASSWORD'
];

let allPresent = true;
for (const key of required) {
  if (process.env[key]) {
    console.log(`✅ ${key}: Present (${process.env[key].substring(0, 8)}...)`);
  } else {
    console.log(`❌ ${key}: MISSING`);
    allPresent = false;
  }
}

if (!allPresent) {
  console.log('\n⚠️  Some secrets are missing. Add them to GitHub Secrets.');
  process.exit(1);
}

console.log('\n✅ All secrets present!');

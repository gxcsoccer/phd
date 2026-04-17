import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN_URL = 'https://api.producthunt.com/v2/oauth/token';
const API_URL = 'https://api.producthunt.com/v2/api/graphql';

const QUERY = `
query DailyPosts($postedAfter: DateTime!, $postedBefore: DateTime!, $after: String) {
  posts(postedAfter: $postedAfter, postedBefore: $postedBefore, order: VOTES, first: 50, after: $after) {
    edges {
      node {
        id
        name
        tagline
        description
        slug
        url
        website
        votesCount
        commentsCount
        createdAt
        featuredAt
        reviewsCount
        reviewsRating
        thumbnail { type url }
        media { type url videoUrl }
        topics { edges { node { id name slug } } }
        makers { id name username headline twitterUsername profileImage }
        productLinks { type url }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

async function getAccessToken() {
  const clientId = process.env.PH_CLIENT_ID;
  const clientSecret = process.env.PH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing PH_CLIENT_ID or PH_CLIENT_SECRET');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

async function graphql(token, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GraphQL ${res.status}: ${text}`);
  }
  const body = JSON.parse(text);
  if (body.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

async function fetchAllPosts(token, postedAfter, postedBefore) {
  const posts = [];
  let after = null;
  let pages = 0;
  while (true) {
    const data = await graphql(token, { postedAfter, postedBefore, after });
    const page = data.posts;
    posts.push(...page.edges.map((e) => e.node));
    pages += 1;
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    // Light throttle to stay well under 6250 complexity / 15 min
    await new Promise((r) => setTimeout(r, 500));
  }
  return { posts, pages };
}

function resolvePtDate(dateArg) {
  // Returns a YYYY-MM-DD string representing a day in America/Los_Angeles.
  // If dateArg is missing, defaults to "yesterday" in PT.
  if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) return dateArg;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayPT = fmt.format(new Date());
  const d = new Date(`${todayPT}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function ptDayBoundariesUtc(dateStr) {
  // Product Hunt "day" follows Pacific Time. Handle DST via Intl.
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName').value;
  const offset = tzName === 'PDT' ? '-07:00' : '-08:00';
  const start = new Date(`${dateStr}T00:00:00${offset}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { postedAfter: start.toISOString(), postedBefore: end.toISOString() };
}

async function main() {
  const dateArg = process.argv[2];
  const date = resolvePtDate(dateArg);
  const { postedAfter, postedBefore } = ptDayBoundariesUtc(date);

  console.log(`Scraping Product Hunt for PT date ${date}`);
  console.log(`  window: ${postedAfter} .. ${postedBefore}`);

  const token = await getAccessToken();
  const { posts, pages } = await fetchAllPosts(token, postedAfter, postedBefore);
  posts.sort((a, b) => b.votesCount - a.votesCount);

  const payload = {
    date,
    timezone: 'America/Los_Angeles',
    postedAfter,
    postedBefore,
    fetchedAt: new Date().toISOString(),
    count: posts.length,
    posts,
  };

  const outPath = `data/${date.slice(0, 4)}/${date}.json`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n');

  console.log(`Saved ${posts.length} posts across ${pages} page(s) -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

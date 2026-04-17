import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Three-layer dedup strategy:
//   Layer 1 (post.id)  — absolute PH-guaranteed unique. Used to detect
//                        intra-day pagination duplicates and already-processed
//                        posts across runs.
//   Layer 2 (slug)     — identifies "same product relaunched". Different id +
//                        same slug as an earlier sighting => relaunch.
//   Layer 3 (semantic) — intentionally not implemented. Revisit after a few
//                        weeks of real data if noise from similar products
//                        becomes a problem.

function parseArgs(argv) {
  const args = { date: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--date') args.date = argv[++i];
    else if (!args.date && /^\d{4}-\d{2}-\d{2}$/.test(a)) args.date = a;
  }
  return args;
}

function resolvePtDate(dateArg) {
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

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const { date: dateArg, force } = parseArgs(process.argv);
  const date = resolvePtDate(dateArg);
  const dataPath = `data/${date.slice(0, 4)}/${date}.json`;

  if (!existsSync(dataPath)) {
    console.error(
      `Missing ${dataPath}. Expected GitHub Actions scrape to have landed this file.`,
    );
    process.exit(2);
  }

  const runs = await readJsonl('state/runs.jsonl');
  const priorRun = runs.find((r) => r.date === date);
  if (priorRun && !force) {
    console.log(
      `already ran: ${date} processed at ${priorRun.processedAt}. Pass --force to reprocess.`,
    );
    process.exit(0);
  }

  const raw = JSON.parse(await readFile(dataPath, 'utf8'));
  const posts = Array.isArray(raw.posts) ? raw.posts : [];

  // Build seen index from history. We only count sightings strictly BEFORE
  // today as relaunch evidence; sightings on `date` itself belong to an
  // earlier run of the same day (rerun / force) and shouldn't flip today's
  // own posts into "relaunch".
  const seenAll = await readJsonl('state/seen.jsonl');
  const seenIds = new Set(); // every id ever recorded (any date)
  const seenIdsBeforeToday = new Set();
  const slugHistory = new Map(); // slug -> [{id, date, name, votes}] strictly before today
  for (const entry of seenAll) {
    if (!entry?.id || !entry?.slug || !entry?.date) continue;
    seenIds.add(entry.id);
    if (entry.date < date) {
      seenIdsBeforeToday.add(entry.id);
      if (!slugHistory.has(entry.slug)) slugHistory.set(entry.slug, []);
      slugHistory.get(entry.slug).push(entry);
    }
  }

  // Layer 1: intra-day dedup by post.id. PH's vote-ordered pagination can
  // return the same post on multiple pages when votes shift mid-scrape.
  const byId = new Map();
  let intraDayDupes = 0;
  for (const p of posts) {
    if (!p?.id || !p?.slug) continue;
    if (byId.has(p.id)) {
      intraDayDupes++;
      // keep the record with the higher vote count
      if (p.votesCount > byId.get(p.id).votesCount) byId.set(p.id, p);
      continue;
    }
    byId.set(p.id, p);
  }
  const unique = [...byId.values()];

  // Classify against history.
  const newLaunches = [];
  const relaunches = [];
  const skipped = []; // id already recorded in a previous run
  for (const p of unique) {
    if (seenIdsBeforeToday.has(p.id)) {
      skipped.push({ id: p.id, slug: p.slug, name: p.name, votes: p.votesCount });
      continue;
    }
    const history = slugHistory.get(p.slug);
    if (history && history.length > 0) {
      const firstSeen = history.map((h) => h.date).sort().at(0);
      relaunches.push({
        ...p,
        _relaunch_of: {
          firstSeen,
          priorLaunches: history.map((h) => ({
            id: h.id,
            date: h.date,
            name: h.name,
            votes: h.votes,
          })),
        },
      });
    } else {
      newLaunches.push(p);
    }
  }

  newLaunches.sort((a, b) => b.votesCount - a.votesCount);
  relaunches.sort((a, b) => b.votesCount - a.votesCount);

  const processedAt = new Date().toISOString();
  const today = {
    date,
    fetchedAt: raw.fetchedAt,
    processedAt,
    summary: {
      rawPosts: posts.length,
      uniquePosts: unique.length,
      new: newLaunches.length,
      relaunch: relaunches.length,
      skipped: skipped.length,
      intraDayDupes,
    },
    new_launches: newLaunches,
    relaunches,
    skipped,
  };

  await mkdir('state', { recursive: true });
  await writeFile('state/today.json', JSON.stringify(today, null, 2) + '\n');

  // Append to seen.jsonl: one line per recorded post sighting. We record both
  // new launches and relaunches (skipped are already on file). On --force
  // reruns we skip appending entirely to avoid duplicate lines for `date`.
  if (!priorRun) {
    const sightings = [...newLaunches, ...relaunches];
    if (sightings.length > 0) {
      const lines =
        sightings
          .map((p) =>
            JSON.stringify({
              id: p.id,
              slug: p.slug,
              name: p.name,
              date,
              votes: p.votesCount,
            }),
          )
          .join('\n') + '\n';
      await appendFile('state/seen.jsonl', lines);
    }
  }

  await appendFile(
    'state/runs.jsonl',
    JSON.stringify({
      date,
      processedAt,
      force: !!force,
      rerun: !!priorRun,
      summary: today.summary,
    }) + '\n',
  );

  console.log(
    `Processed ${date}: ${today.summary.new} new / ${today.summary.relaunch} relaunch / ${today.summary.skipped} skipped / ${intraDayDupes} intra-day id dupes`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

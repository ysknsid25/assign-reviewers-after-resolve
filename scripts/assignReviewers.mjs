import fs from 'fs';
import path from 'path';

const {
  INPUT_GITHUB_TOKEN,
  INPUT_REVIEWERS_FILE,
  INPUT_TRIGGER_LABEL,
  INPUT_EXCLUDE_AUTHORS,
  INPUT_PR_NUMBER,
  INPUT_PR_AUTHOR,
  INPUT_REPOSITORY,
  INPUT_ON_UNRESOLVED,
  INPUT_DRY_RUN,
  EVENT_LABEL_NAME,
  GITHUB_WORKSPACE,
  GITHUB_OUTPUT,
} = process.env;

// No-op when trigger-label is set and does not match the event label
if (INPUT_TRIGGER_LABEL && EVENT_LABEL_NAME !== INPUT_TRIGGER_LABEL) {
  console.log(`Label "${EVENT_LABEL_NAME}" does not match trigger-label "${INPUT_TRIGGER_LABEL}". Skipping.`);
  process.exit(0);
}

if (!INPUT_PR_NUMBER) {
  console.log('PR number is not available. Skipping.');
  process.exit(0);
}

const [owner, repo] = INPUT_REPOSITORY.split('/');
const prNumber = Number(INPUT_PR_NUMBER);
const prAuthor = INPUT_PR_AUTHOR ?? '';
const onUnresolved = INPUT_ON_UNRESOLVED ?? 'fail';
const isDryRun = INPUT_DRY_RUN === 'true';

// Parse exclude-authors: comma-separated logins (trimmed, lowercased for case-insensitive match)
const excludeAuthors = new Set(
  (INPUT_EXCLUDE_AUTHORS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

/**
 * Read a CODEOWNERS-compatible file and return individual user logins (excludes @org/team).
 * @returns {Set<string>}
 */
function parseReviewersFile() {
  const filePath = path.resolve(GITHUB_WORKSPACE ?? '.', INPUT_REVIEWERS_FILE ?? '.github/REVIEWERS');
  if (!fs.existsSync(filePath)) {
    console.error(`Reviewers file not found: ${filePath}`);
    console.error('Make sure "actions/checkout" ran before this action.');
    process.exit(1);
  }
  const members = new Set();
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const matches = trimmed.match(/@([\w-]+)/g);
    if (matches) {
      // Skip @org/team entries; keep individual users only
      matches
        .filter(m => !m.includes('/'))
        .forEach(m => members.add(m.slice(1)));
    }
  }
  return members;
}

/**
 * Count unresolved review threads via GraphQL, skipping threads authored by the PR author
 * or any login in the excludeAuthors set.
 * @returns {Promise<number>}
 */
async function countUnresolvedThreads() {
  let unresolved = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100, after: $cursor) {
              nodes {
                isResolved
                comments(first: 1) {
                  nodes {
                    author {
                      login
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;

    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INPUT_GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { owner, repo, prNumber, cursor },
      }),
    });

    if (!response.ok) {
      console.error(`GraphQL request failed: ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const data = await response.json();
    const reviewThreads = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) {
      console.error('Failed to fetch reviewThreads:', JSON.stringify(data));
      process.exit(1);
    }

    for (const node of reviewThreads.nodes) {
      if (node.isResolved) continue;
      const threadAuthor = node.comments.nodes[0]?.author?.login;
      // Skip threads authored by PR author or any excluded account
      if (threadAuthor === prAuthor || excludeAuthors.has(threadAuthor)) continue;
      unresolved++;
    }

    hasNextPage = reviewThreads.pageInfo.hasNextPage;
    cursor = reviewThreads.pageInfo.endCursor;
  }

  return unresolved;
}

/**
 * Return the set of already-requested reviewers for this PR.
 * @returns {Promise<Set<string>>}
 */
async function getExistingRequestedReviewers() {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
    {
      headers: {
        Authorization: `Bearer ${INPUT_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!response.ok) {
    console.error(`Failed to fetch requested reviewers: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const data = await response.json();
  return new Set((data.users ?? []).map(u => u.login));
}

/**
 * Request the given logins as reviewers on this PR.
 * @param {string[]} reviewers
 */
async function requestReviewers(reviewers) {
  if (isDryRun) {
    console.log(`[dry-run] Would assign reviewers: ${reviewers.join(', ')}`);
    return;
  }
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INPUT_GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reviewers }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    console.error(`Failed to assign reviewers: ${response.status} ${body}`);
    process.exit(1);
  }
}

/**
 * Write a key=value pair to $GITHUB_OUTPUT (if available).
 * @param {string} key
 * @param {string} value
 */
function setOutput(key, value) {
  if (GITHUB_OUTPUT) {
    fs.appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

// --- Main ---

const unresolvedCount = await countUnresolvedThreads();
console.log(`Unresolved review threads: ${unresolvedCount}`);
setOutput('unresolved_count', String(unresolvedCount));

if (unresolvedCount > 0) {
  const message = `${unresolvedCount} unresolved review thread(s) remain. Resolve all threads before applying the "${INPUT_TRIGGER_LABEL}" label.`;
  if (onUnresolved === 'fail') {
    console.error(message);
    process.exit(1);
  }
  else if (onUnresolved === 'warn') {
    console.warn(`Warning: ${message}`);
  }
  // 'skip' or 'warn': exit normally
  setOutput('assigned_reviewers', '');
  process.exit(0);
}

const reviewersFileMembers = parseReviewersFile();
const existingReviewers = await getExistingRequestedReviewers();

// Exclude PR author, already-requested users, and any explicitly excluded accounts
const toAssign = [...reviewersFileMembers].filter(
  login => login !== prAuthor && !existingReviewers.has(login) && !excludeAuthors.has(login),
);

setOutput('assigned_reviewers', toAssign.join(','));

if (toAssign.length === 0) {
  console.log('No new reviewers to assign (all already assigned or excluded).');
  process.exit(0);
}

await requestReviewers(toAssign);
console.log(`Assigned reviewers: ${toAssign.join(', ')}`);

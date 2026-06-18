import fs from 'fs';
import path from 'path';
/**
 * Select reviewers from the candidates list.
 * When count is "all" (or omitted), returns all candidates.
 * When count is a positive integer, returns that many candidates picked at random.
 */
export function selectReviewers(candidates, assignCount) {
    if (assignCount === 'all') {
        return candidates;
    }
    const n = Number(assignCount);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`assign-count must be "all" or a positive integer, got: "${assignCount}"`);
    }
    if (n >= candidates.length) {
        return candidates;
    }
    // Fisher-Yates partial shuffle to pick n items
    const pool = [...candidates];
    for (let i = 0; i < n; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
}
/**
 * Read a CODEOWNERS-compatible file and return individual user logins (excludes @org/team).
 */
export function parseReviewersFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Reviewers file not found: ${filePath}\nMake sure "actions/checkout" ran before this action.`);
    }
    const members = new Set();
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const matches = trimmed.match(/@[\w-]+(?:\/[\w-]+)?/g);
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
 */
export async function countUnresolvedThreads(token, owner, repo, prNumber, prAuthor, excludeAuthors, fetcher = fetch) {
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
        const response = await fetcher('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query,
                variables: { owner, repo, prNumber, cursor },
            }),
        });
        if (!response.ok) {
            throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        const reviewThreads = data?.data?.repository?.pullRequest?.reviewThreads;
        if (!reviewThreads) {
            throw new Error(`Failed to fetch reviewThreads: ${JSON.stringify(data)}`);
        }
        for (const node of reviewThreads.nodes) {
            if (node.isResolved)
                continue;
            const threadAuthor = node.comments.nodes[0]?.author?.login;
            // Skip threads authored by PR author or any excluded account
            if (threadAuthor === prAuthor || (threadAuthor !== undefined && excludeAuthors.has(threadAuthor)))
                continue;
            unresolved++;
        }
        hasNextPage = reviewThreads.pageInfo.hasNextPage;
        cursor = reviewThreads.pageInfo.endCursor;
    }
    return unresolved;
}
/**
 * Return the set of already-requested reviewers for this PR.
 */
export async function getExistingRequestedReviewers(token, owner, repo, prNumber, fetcher = fetch) {
    const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch requested reviewers: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return new Set((data.users ?? []).map(u => u.login));
}
/**
 * Request the given logins as reviewers on this PR.
 */
export async function requestReviewers(token, owner, repo, prNumber, reviewers, fetcher = fetch) {
    const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reviewers }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed to assign reviewers: ${response.status} ${body}`);
    }
}
/**
 * Write a key=value pair to $GITHUB_OUTPUT (if available).
 */
export function setOutput(key, value, outputFile) {
    if (outputFile) {
        fs.appendFileSync(outputFile, `${key}=${value}\n`);
    }
}
/**
 * Main entry point. Exported for testability.
 */
export async function run(env, fetcher = fetch) {
    const { INPUT_GITHUB_TOKEN, INPUT_REVIEWERS_FILE, INPUT_TRIGGER_LABEL, INPUT_EXCLUDE_AUTHORS, INPUT_PR_NUMBER, INPUT_PR_AUTHOR, INPUT_REPOSITORY, INPUT_ON_UNRESOLVED, INPUT_DRY_RUN, INPUT_ASSIGN_COUNT, EVENT_LABEL_NAME, GITHUB_WORKSPACE, GITHUB_OUTPUT, } = env;
    // No-op when trigger-label is set and does not match the event label
    if (INPUT_TRIGGER_LABEL && EVENT_LABEL_NAME !== INPUT_TRIGGER_LABEL) {
        console.log(`Label "${EVENT_LABEL_NAME}" does not match trigger-label "${INPUT_TRIGGER_LABEL}". Skipping.`);
        return;
    }
    if (!INPUT_PR_NUMBER) {
        console.log('PR number is not available. Skipping.');
        return;
    }
    if (!INPUT_REPOSITORY) {
        throw new Error('INPUT_REPOSITORY is required');
    }
    if (!INPUT_GITHUB_TOKEN) {
        throw new Error('INPUT_GITHUB_TOKEN is required');
    }
    const [owner, repo] = INPUT_REPOSITORY.split('/');
    const prNumber = Number(INPUT_PR_NUMBER);
    const prAuthor = INPUT_PR_AUTHOR ?? '';
    const onUnresolved = INPUT_ON_UNRESOLVED ?? 'fail';
    const isDryRun = INPUT_DRY_RUN === 'true';
    const assignCount = INPUT_ASSIGN_COUNT?.trim() || 'all';
    // Parse exclude-authors: comma-separated logins (trimmed, lowercased for case-insensitive match)
    const excludeAuthors = new Set((INPUT_EXCLUDE_AUTHORS ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean));
    const unresolvedCount = await countUnresolvedThreads(INPUT_GITHUB_TOKEN, owner, repo, prNumber, prAuthor, excludeAuthors, fetcher);
    console.log(`Unresolved review threads: ${unresolvedCount}`);
    setOutput('unresolved_count', String(unresolvedCount), GITHUB_OUTPUT);
    if (unresolvedCount > 0) {
        const message = `${unresolvedCount} unresolved review thread(s) remain. Resolve all threads before applying the "${INPUT_TRIGGER_LABEL}" label.`;
        if (onUnresolved === 'fail') {
            throw new Error(message);
        }
        else if (onUnresolved === 'warn') {
            console.warn(`Warning: ${message}`);
        }
        // 'skip' or 'warn': exit normally
        setOutput('assigned_reviewers', '', GITHUB_OUTPUT);
        return;
    }
    const filePath = path.resolve(GITHUB_WORKSPACE ?? '.', INPUT_REVIEWERS_FILE ?? '.github/REVIEWERS');
    const reviewersFileMembers = parseReviewersFile(filePath);
    const existingReviewers = await getExistingRequestedReviewers(INPUT_GITHUB_TOKEN, owner, repo, prNumber, fetcher);
    // Exclude PR author, already-requested users, and any explicitly excluded accounts
    const candidates = [...reviewersFileMembers].filter(login => login !== prAuthor && !existingReviewers.has(login) && !excludeAuthors.has(login));
    const toAssign = selectReviewers(candidates, assignCount);
    setOutput('assigned_reviewers', toAssign.join(','), GITHUB_OUTPUT);
    if (toAssign.length === 0) {
        console.log('No new reviewers to assign (all already assigned or excluded).');
        return;
    }
    if (isDryRun) {
        console.log(`[dry-run] Would assign reviewers: ${toAssign.join(', ')}`);
        return;
    }
    await requestReviewers(INPUT_GITHUB_TOKEN, owner, repo, prNumber, toAssign, fetcher);
    console.log(`Assigned reviewers: ${toAssign.join(', ')}`);
}

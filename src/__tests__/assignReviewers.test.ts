import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countUnresolvedThreads,
  getExistingRequestedReviewers,
  parseReviewersFile,
  requestReviewers,
  run,
  selectReviewers,
  setOutput,
} from '../assignReviewers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReviewersFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const file = path.join(dir, 'REVIEWERS');
  fs.writeFileSync(file, content);
  return file;
}

function makeJsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// parseReviewersFile
// ---------------------------------------------------------------------------

describe('parseReviewersFile', () => {
  it('parses individual user logins', () => {
    const file = makeReviewersFile('* @alice @bob\n');
    expect(parseReviewersFile(file)).toEqual(new Set(['alice', 'bob']));
  });

  it('ignores comment lines', () => {
    const file = makeReviewersFile('# comment\n* @alice\n');
    expect(parseReviewersFile(file)).toEqual(new Set(['alice']));
  });

  it('ignores org/team entries', () => {
    const file = makeReviewersFile('* @myorg/frontend @carol\n');
    expect(parseReviewersFile(file)).toEqual(new Set(['carol']));
  });

  it('ignores empty lines', () => {
    const file = makeReviewersFile('\n\n* @dave\n\n');
    expect(parseReviewersFile(file)).toEqual(new Set(['dave']));
  });

  it('throws when file does not exist', () => {
    expect(() => parseReviewersFile('/nonexistent/REVIEWERS')).toThrow('Reviewers file not found');
  });
});

// ---------------------------------------------------------------------------
// setOutput
// ---------------------------------------------------------------------------

describe('setOutput', () => {
  it('appends key=value to the output file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
    const file = path.join(dir, 'output');
    fs.writeFileSync(file, '');
    setOutput('foo', 'bar', file);
    expect(fs.readFileSync(file, 'utf8')).toBe('foo=bar\n');
  });

  it('is a no-op when outputFile is undefined', () => {
    expect(() => setOutput('foo', 'bar', undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// selectReviewers
// ---------------------------------------------------------------------------

describe('selectReviewers', () => {
  const candidates = ['alice', 'bob', 'carol', 'dave'];

  it('returns all candidates when count is "all"', () => {
    expect(selectReviewers(candidates, 'all')).toEqual(candidates);
  });

  it('returns all candidates when count equals candidates length', () => {
    const result = selectReviewers(candidates, '4');
    expect(result).toHaveLength(4);
    expect(new Set(result)).toEqual(new Set(candidates));
  });

  it('returns all candidates when count exceeds candidates length', () => {
    const result = selectReviewers(candidates, '10');
    expect(result).toHaveLength(4);
    expect(new Set(result)).toEqual(new Set(candidates));
  });

  it('returns n unique candidates when count is less than candidates length', () => {
    const result = selectReviewers(candidates, '2');
    expect(result).toHaveLength(2);
    expect(new Set(result).size).toBe(2);
    result.forEach(login => expect(candidates).toContain(login));
  });

  it('throws on non-positive integer', () => {
    expect(() => selectReviewers(candidates, '0')).toThrow('assign-count');
    expect(() => selectReviewers(candidates, '-1')).toThrow('assign-count');
    expect(() => selectReviewers(candidates, 'foo')).toThrow('assign-count');
  });
});

// ---------------------------------------------------------------------------
// countUnresolvedThreads
// ---------------------------------------------------------------------------

describe('countUnresolvedThreads', () => {
  it('counts only unresolved threads not authored by excluded accounts', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  { isResolved: true, comments: { nodes: [{ author: { login: 'alice' } }] } },
                  { isResolved: false, comments: { nodes: [{ author: { login: 'alice' } }] } }, // PR author – skip
                  { isResolved: false, comments: { nodes: [{ author: { login: 'bot' } }] } }, // excluded – skip
                  { isResolved: false, comments: { nodes: [{ author: { login: 'carol' } }] } }, // count
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    );

    const count = await countUnresolvedThreads('token', 'owner', 'repo', 1, 'alice', new Set(['bot']), fetcher);
    expect(count).toBe(1);
  });

  it('handles pagination', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { isResolved: false, comments: { nodes: [{ author: { login: 'user1' } }] } },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { isResolved: false, comments: { nodes: [{ author: { login: 'user2' } }] } },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );

    const count = await countUnresolvedThreads('token', 'owner', 'repo', 1, '', new Set(), fetcher);
    expect(count).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws on non-ok response', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' } as Response);
    await expect(
      countUnresolvedThreads('token', 'owner', 'repo', 1, '', new Set(), fetcher),
    ).rejects.toThrow('GraphQL request failed: 403 Forbidden');
  });

  it('throws when reviewThreads is missing', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeJsonResponse({ data: {} }));
    await expect(
      countUnresolvedThreads('token', 'owner', 'repo', 1, '', new Set(), fetcher),
    ).rejects.toThrow('Failed to fetch reviewThreads');
  });
});

// ---------------------------------------------------------------------------
// getExistingRequestedReviewers
// ---------------------------------------------------------------------------

describe('getExistingRequestedReviewers', () => {
  it('returns a set of reviewer logins', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      makeJsonResponse({ users: [{ login: 'alice' }, { login: 'bob' }] }),
    );
    const result = await getExistingRequestedReviewers('token', 'owner', 'repo', 1, fetcher);
    expect(result).toEqual(new Set(['alice', 'bob']));
  });

  it('returns empty set when users is absent', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeJsonResponse({}));
    const result = await getExistingRequestedReviewers('token', 'owner', 'repo', 1, fetcher);
    expect(result).toEqual(new Set());
  });

  it('throws on non-ok response', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' } as Response);
    await expect(
      getExistingRequestedReviewers('token', 'owner', 'repo', 1, fetcher),
    ).rejects.toThrow('Failed to fetch requested reviewers: 404 Not Found');
  });
});

// ---------------------------------------------------------------------------
// requestReviewers
// ---------------------------------------------------------------------------

describe('requestReviewers', () => {
  it('posts to the correct endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeJsonResponse({}));
    await requestReviewers('token', 'owner', 'repo', 42, ['alice', 'bob'], fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls/42/requested_reviewers',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on non-ok response', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: () => Promise.resolve('error body'),
    } as unknown as Response);
    await expect(
      requestReviewers('token', 'owner', 'repo', 1, ['alice'], fetcher),
    ).rejects.toThrow('Failed to assign reviewers: 422 error body');
  });
});

// ---------------------------------------------------------------------------
// run (integration-style)
// ---------------------------------------------------------------------------

describe('run', () => {
  let tmpDir: string;
  let reviewersFile: string;
  let outputFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
    reviewersFile = path.join(tmpDir, 'REVIEWERS');
    fs.writeFileSync(reviewersFile, '* @alice @bob\n');
    outputFile = path.join(tmpDir, 'github_output');
    fs.writeFileSync(outputFile, '');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true });
  });

  function baseEnv(): Record<string, string> {
    return {
      INPUT_GITHUB_TOKEN: 'token',
      INPUT_REVIEWERS_FILE: reviewersFile,
      INPUT_TRIGGER_LABEL: '',
      INPUT_EXCLUDE_AUTHORS: '',
      INPUT_PR_NUMBER: '1',
      INPUT_PR_AUTHOR: 'author',
      INPUT_REPOSITORY: 'owner/repo',
      INPUT_ON_UNRESOLVED: 'fail',
      INPUT_DRY_RUN: 'false',
      EVENT_LABEL_NAME: '',
      GITHUB_WORKSPACE: '',
      GITHUB_OUTPUT: outputFile,
    };
  }

  function noUnresolvedFetcher(): typeof fetch {
    return vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }))
      .mockResolvedValueOnce(makeJsonResponse({ users: [] }))
      .mockResolvedValueOnce(makeJsonResponse({})) as unknown as typeof fetch;
  }

  it('skips when trigger-label does not match', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await run({
      ...baseEnv(),
      INPUT_TRIGGER_LABEL: 'ReviewReady',
      EVENT_LABEL_NAME: 'other-label',
    }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips when PR number is absent', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await run({ ...baseEnv(), INPUT_PR_NUMBER: '' }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('assigns reviewers when no unresolved threads', async () => {
    const fetcher = noUnresolvedFetcher();
    await run(baseEnv(), fetcher);
    const output = fs.readFileSync(outputFile, 'utf8');
    expect(output).toContain('unresolved_count=0');
    // alice and bob should be assigned (author excluded)
    expect(output).toMatch(/assigned_reviewers=alice,bob|assigned_reviewers=bob,alice/);
  });

  it('throws when unresolved > 0 and on-unresolved=fail', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeJsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' } }] } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })) as unknown as typeof fetch;
    await expect(run({ ...baseEnv(), INPUT_ON_UNRESOLVED: 'fail' }, fetcher)).rejects.toThrow('unresolved review thread');
  });

  it('warns and exits when unresolved > 0 and on-unresolved=warn', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeJsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false, comments: { nodes: [{ author: { login: 'reviewer' } }] } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    })) as unknown as typeof fetch;
    await run({ ...baseEnv(), INPUT_ON_UNRESOLVED: 'warn' }, fetcher);
    expect(console.warn).toHaveBeenCalled();
  });

  it('logs dry-run message instead of calling API', async () => {
    const fetcher = noUnresolvedFetcher();
    await run({ ...baseEnv(), INPUT_DRY_RUN: 'true' }, fetcher);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
  });

  it('assigns only n reviewers when assign-count is a number', async () => {
    fs.writeFileSync(reviewersFile, '* @alice @bob @carol\n');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }))
      .mockResolvedValueOnce(makeJsonResponse({ users: [] }))
      .mockResolvedValueOnce(makeJsonResponse({})) as unknown as typeof fetch;

    await run({ ...baseEnv(), INPUT_ASSIGN_COUNT: '1' }, fetcher);
    const output = fs.readFileSync(outputFile, 'utf8');
    const match = output.match(/assigned_reviewers=(.+)/);
    expect(match).not.toBeNull();
    const assigned = match![1].split(',').filter(Boolean);
    expect(assigned).toHaveLength(1);
    expect(['alice', 'bob', 'carol']).toContain(assigned[0]);
  });

  it('logs when no new reviewers to assign', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }))
      // already all requested
      .mockResolvedValueOnce(makeJsonResponse({ users: [{ login: 'alice' }, { login: 'bob' }] })) as unknown as typeof fetch;

    await run(baseEnv(), fetcher);
    expect(console.log).toHaveBeenCalledWith('No new reviewers to assign (all already assigned or excluded).');
  });
});

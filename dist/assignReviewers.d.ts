export interface Env {
    INPUT_GITHUB_TOKEN?: string;
    INPUT_REVIEWERS_FILE?: string;
    INPUT_TRIGGER_LABEL?: string;
    INPUT_EXCLUDE_AUTHORS?: string;
    INPUT_PR_NUMBER?: string;
    INPUT_PR_AUTHOR?: string;
    INPUT_REPOSITORY?: string;
    INPUT_ON_UNRESOLVED?: string;
    INPUT_DRY_RUN?: string;
    INPUT_ASSIGN_COUNT?: string;
    EVENT_LABEL_NAME?: string;
    GITHUB_WORKSPACE?: string;
    GITHUB_OUTPUT?: string;
}
export interface ReviewThread {
    isResolved: boolean;
    comments: {
        nodes: {
            author: {
                login: string;
            } | null;
        }[];
    };
}
export interface PageInfo {
    hasNextPage: boolean;
    endCursor: string | null;
}
export interface GraphQLResponse {
    data?: {
        repository?: {
            pullRequest?: {
                reviewThreads?: {
                    nodes: ReviewThread[];
                    pageInfo: PageInfo;
                };
            };
        };
    };
}
export type OnUnresolved = 'fail' | 'warn' | 'skip';
/**
 * Select reviewers from the candidates list.
 * When count is "all" (or omitted), returns all candidates.
 * When count is a positive integer, returns that many candidates picked at random.
 */
export declare function selectReviewers(candidates: string[], assignCount: string): string[];
/**
 * Read a CODEOWNERS-compatible file and return individual user logins (excludes @org/team).
 */
export declare function parseReviewersFile(filePath: string): Set<string>;
/**
 * Count unresolved review threads via GraphQL, skipping threads authored by the PR author
 * or any login in the excludeAuthors set.
 */
export declare function countUnresolvedThreads(token: string, owner: string, repo: string, prNumber: number, prAuthor: string, excludeAuthors: Set<string>, fetcher?: typeof fetch): Promise<number>;
/**
 * Return the set of already-requested reviewers for this PR.
 */
export declare function getExistingRequestedReviewers(token: string, owner: string, repo: string, prNumber: number, fetcher?: typeof fetch): Promise<Set<string>>;
/**
 * Request the given logins as reviewers on this PR.
 */
export declare function requestReviewers(token: string, owner: string, repo: string, prNumber: number, reviewers: string[], fetcher?: typeof fetch): Promise<void>;
/**
 * Write a key=value pair to $GITHUB_OUTPUT (if available).
 */
export declare function setOutput(key: string, value: string, outputFile?: string): void;
/**
 * Main entry point. Exported for testability.
 */
export declare function run(env: Env, fetcher?: typeof fetch): Promise<void>;

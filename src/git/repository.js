import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { sync as commandExistsSync } from 'command-exists';
import simpleGit from 'simple-git';

const DEFAULT_REMOTE = 'origin';
const MAX_UNSHALLOW_DEPTH = 2_147_483_647;
const require = createRequire(import.meta.url);

let git = null;
let http = null;

try {
    git = require('isomorphic-git');

    try {
        http = require('isomorphic-git/http/node');
    } catch {
        http = require('isomorphic-git/http/node/index.cjs');
    }
} catch {
    // isomorphic-git dependency is optional at startup when using only system backend
}

export const GIT_BACKENDS = Object.freeze({
    AUTO: 'auto',
    SYSTEM: 'system',
    ISOMORPHIC: 'isomorphic',
});

/**
 * @param {string | undefined | null} value
 * @returns {'auto' | 'system' | 'isomorphic'}
 */
function normalizeGitBackend(value) {
    const backend = String(value ?? GIT_BACKENDS.AUTO).trim().toLowerCase();

    if (backend === GIT_BACKENDS.SYSTEM || backend === GIT_BACKENDS.ISOMORPHIC) {
        return backend;
    }

    return GIT_BACKENDS.AUTO;
}

/**
 * @returns {boolean}
 */
export function hasSystemGit() {
    return commandExistsSync('git');
}

/**
 * @returns {boolean}
 */
export function hasIsomorphicGit() {
    return Boolean(git && http);
}

function assertIsomorphicGitAvailable() {
    if (!hasIsomorphicGit()) {
        throw new Error('Isomorphic git backend is unavailable. Run npm install to install dependencies.');
    }
}

/**
 * Resolves the configured backend into the actual backend to use.
 * @param {string | undefined | null} preferredBackend
 * @returns {'system' | 'isomorphic'}
 */
export function resolveGitBackend(preferredBackend) {
    const backend = normalizeGitBackend(preferredBackend);

    if (backend === GIT_BACKENDS.SYSTEM) {
        if (!hasSystemGit()) {
            throw new Error('System git backend is configured, but no git binary was found in PATH.');
        }

        return GIT_BACKENDS.SYSTEM;
    }

    if (backend === GIT_BACKENDS.ISOMORPHIC) {
        assertIsomorphicGitAvailable();
        return GIT_BACKENDS.ISOMORPHIC;
    }

    if (hasSystemGit()) {
        return GIT_BACKENDS.SYSTEM;
    }

    assertIsomorphicGitAvailable();
    return GIT_BACKENDS.ISOMORPHIC;
}

/**
 * @param {{ baseDir?: string, timeoutMs?: number, backend?: string }} [options]
 * @returns {SystemGitRepository | IsomorphicGitRepository}
 */
export function createGitRepository(options = {}) {
    const backend = resolveGitBackend(options.backend);

    if (backend === GIT_BACKENDS.SYSTEM) {
        return new SystemGitRepository(options);
    }

    return new IsomorphicGitRepository(options);
}

class SystemGitRepository {
    /**
     * @param {{ baseDir?: string, timeoutMs?: number }} options
     */
    constructor({ baseDir, timeoutMs }) {
        const simpleGitOptions = {};

        if (baseDir) {
            simpleGitOptions.baseDir = baseDir;
        }

        if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            simpleGitOptions.timeout = { block: timeoutMs };
        }

        this.backend = GIT_BACKENDS.SYSTEM;
        this.baseDir = baseDir ? path.resolve(baseDir) : null;
        this.git = simpleGit(simpleGitOptions);
    }

    async checkIsRepoRoot() {
        try {
            const topLevel = (await this.git.revparse(['--show-toplevel'])).trim();

            if (!this.baseDir) {
                return true;
            }

            return path.resolve(topLevel) === this.baseDir;
        } catch {
            return false;
        }
    }

    async fetch(remote = DEFAULT_REMOTE, options = []) {
        if (Array.isArray(options) && options.length > 0) {
            await this.git.fetch(remote, options);
            return;
        }

        if (remote) {
            await this.git.fetch(remote);
            return;
        }

        await this.git.fetch();
    }

    async revparse(args) {
        return (await this.git.revparse(args)).trim();
    }

    async show(args) {
        return this.git.show(args);
    }

    async log(args) {
        return this.git.log(args);
    }

    async getRemotes(verbose = false) {
        return this.git.getRemotes(verbose);
    }

    async pull(remote, branch) {
        if (remote && branch) {
            await this.git.pull(remote, branch);
            return;
        }

        if (remote) {
            await this.git.pull(remote);
            return;
        }

        await this.git.pull();
    }

    async clone(url, localPath, options = {}) {
        await this.git.clone(url, localPath, options);
    }

    async branch(options = []) {
        if (Array.isArray(options) && options.length > 0) {
            return this.git.branch(options);
        }

        return this.git.branch();
    }

    async branchLocal() {
        return this.git.branchLocal();
    }

    async checkout(branchName) {
        await this.git.checkout(branchName);
    }

    async checkoutBranch(localBranch, startPoint) {
        await this.git.checkoutBranch(localBranch, startPoint);
    }

    async remote(args) {
        return this.git.remote(args);
    }
}

class IsomorphicGitRepository {
    /**
     * @param {{ baseDir?: string, timeoutMs?: number }} options
     */
    constructor({ baseDir, timeoutMs }) {
        assertIsomorphicGitAvailable();
        this.backend = GIT_BACKENDS.ISOMORPHIC;
        this.baseDir = baseDir ? path.resolve(baseDir) : null;
        this.timeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : null;
    }

    /**
     * @returns {string}
     */
    getBaseDirOrThrow() {
        if (!this.baseDir) {
            throw new Error('This git operation requires a repository baseDir.');
        }

        return this.baseDir;
    }

    /**
     * @param {string=} dirOverride
     * @returns {{ fs: typeof fs, dir: string, http: import('isomorphic-git').HttpClient }}
     */
    getRepoOptions(dirOverride) {
        return {
            fs,
            dir: path.resolve(dirOverride ?? this.getBaseDirOrThrow()),
            http,
        };
    }

    /**
     * @template T
     * @param {string} operationName
     * @param {(signal?: AbortSignal) => Promise<T>} operation
     * @returns {Promise<T>}
     */
    async withTimeout(operationName, operation) {
        if (!this.timeoutMs) {
            return operation();
        }

        const controller = new AbortController();
        let timeoutId;

        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error(`Git ${operationName} timed out after ${this.timeoutMs}ms.`));
            }, this.timeoutMs);
        });

        try {
            return await Promise.race([
                operation(controller.signal),
                timeoutPromise,
            ]);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * @param {string} dir
     * @returns {string | null}
     */
    resolveGitDir(dir) {
        const dotGitPath = path.join(dir, '.git');

        if (!fs.existsSync(dotGitPath)) {
            return null;
        }

        const stats = fs.statSync(dotGitPath);
        if (stats.isDirectory()) {
            return fs.existsSync(path.join(dotGitPath, 'HEAD')) ? dotGitPath : null;
        }

        if (!stats.isFile()) {
            return null;
        }

        const dotGitContent = fs.readFileSync(dotGitPath, 'utf8');
        const match = dotGitContent.match(/^gitdir:\s*(.+)$/im);

        if (!match?.[1]) {
            return null;
        }

        const resolvedGitDir = path.resolve(dir, match[1].trim());
        return fs.existsSync(path.join(resolvedGitDir, 'HEAD')) ? resolvedGitDir : null;
    }

    /**
     * @param {number} rawTimestamp
     * @returns {number}
     */
    toTimestampMs(rawTimestamp) {
        if (!Number.isFinite(rawTimestamp)) {
            return 0;
        }

        // isomorphic-git timestamps are normally in seconds.
        return rawTimestamp > 1_000_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
    }

    /**
     * @param {import('isomorphic-git').CommitObject} commit
     * @returns {string}
     */
    formatCommitDateCI(commit) {
        const committer = commit.committer ?? commit.author;
        const timestampMs = this.toTimestampMs(Number(committer?.timestamp ?? 0));
        const timezoneOffset = Number(committer?.timezoneOffset ?? 0);
        const shiftedTimestamp = timestampMs - timezoneOffset * 60_000;
        const date = new Date(shiftedTimestamp);

        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        const absOffset = Math.abs(timezoneOffset);
        const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
        const offsetMinutes = String(absOffset % 60).padStart(2, '0');
        const sign = timezoneOffset <= 0 ? '+' : '-';

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${sign}${offsetHours}${offsetMinutes}`;
    }

    /**
     * @param {string} ref
     * @returns {Promise<string>}
     */
    async resolveRef(ref) {
        const repo = this.getRepoOptions();
        const rawRef = String(ref ?? '').trim();

        if (!rawRef) {
            throw new Error('Cannot resolve an empty git ref.');
        }

        if (/^[0-9a-f]{4,40}$/i.test(rawRef)) {
            try {
                return await git.expandOid({ ...repo, oid: rawRef.toLowerCase() });
            } catch {
                // not an object id, continue with ref resolution
            }
        }

        const candidates = [];

        if (rawRef.startsWith('refs/')) {
            candidates.push(rawRef);
        } else {
            if (rawRef === 'HEAD') {
                candidates.push('HEAD');
            }

            if (rawRef.includes('/')) {
                candidates.push(`refs/remotes/${rawRef}`);
            }

            candidates.push(rawRef);
            candidates.push(`refs/heads/${rawRef}`);
            candidates.push(`refs/tags/${rawRef}`);
        }

        for (const candidate of new Set(candidates)) {
            try {
                return await git.resolveRef({ ...repo, ref: candidate });
            } catch {
                // try next candidate
            }
        }

        throw new Error(`Could not resolve git ref: ${rawRef}`);
    }

    /**
     * @param {string} startOid
     * @returns {Promise<Set<string>>}
     */
    async collectReachableCommitSet(startOid) {
        const repo = this.getRepoOptions();
        const visited = new Set();
        const stack = [startOid];

        while (stack.length > 0) {
            const oid = stack.pop();

            if (!oid || visited.has(oid)) {
                continue;
            }

            visited.add(oid);

            try {
                const { commit } = await git.readCommit({ ...repo, oid });
                for (const parentOid of commit.parent ?? []) {
                    if (!visited.has(parentOid)) {
                        stack.push(parentOid);
                    }
                }
            } catch {
                // Ignore missing parent objects (e.g. shallow history) and keep traversing known commits.
            }
        }

        return visited;
    }

    /**
     * @param {string} startOid
     * @param {Set<string>} excludedOids
     * @returns {Promise<Array<{ oid: string, commit: import('isomorphic-git').CommitObject }>>}
     */
    async collectCommitsExcluding(startOid, excludedOids) {
        const repo = this.getRepoOptions();
        const visited = new Set();
        const stack = [startOid];
        const commits = [];

        while (stack.length > 0) {
            const oid = stack.pop();

            if (!oid || visited.has(oid) || excludedOids.has(oid)) {
                continue;
            }

            visited.add(oid);

            try {
                const { commit } = await git.readCommit({ ...repo, oid });
                commits.push({ oid, commit });

                for (const parentOid of commit.parent ?? []) {
                    if (!visited.has(parentOid) && !excludedOids.has(parentOid)) {
                        stack.push(parentOid);
                    }
                }
            } catch {
                // Ignore missing parent objects (e.g. shallow history) and continue with known commits.
            }
        }

        commits.sort((a, b) => {
            const aTime = Number(a.commit.committer?.timestamp ?? a.commit.author?.timestamp ?? 0);
            const bTime = Number(b.commit.committer?.timestamp ?? b.commit.author?.timestamp ?? 0);
            return bTime - aTime;
        });

        return commits;
    }

    /**
     * @returns {Promise<string>}
     */
    async getTrackingBranchName() {
        const repo = this.getRepoOptions();
        const currentBranch = await git.currentBranch(repo);

        if (!currentBranch) {
            throw new Error('Cannot resolve upstream branch while HEAD is detached.');
        }

        const remote = await git.getConfig({
            ...repo,
            path: `branch.${currentBranch}.remote`,
        }) || DEFAULT_REMOTE;

        const mergeRef = await git.getConfig({
            ...repo,
            path: `branch.${currentBranch}.merge`,
        });

        if (!mergeRef) {
            throw new Error(`No upstream tracking branch configured for ${currentBranch}.`);
        }

        const mergeBranch = mergeRef.replace(/^refs\/heads\//, '');
        return `${remote}/${mergeBranch}`;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async checkIsRepoRoot() {
        const baseDir = this.getBaseDirOrThrow();
        return this.resolveGitDir(baseDir) !== null;
    }

    /**
     * @param {string} [remote]
     * @param {string[]} [options]
     */
    async fetch(remote = DEFAULT_REMOTE, options = []) {
        const repo = this.getRepoOptions();
        const shouldUnshallow = Array.isArray(options) && options.includes('--unshallow');

        const fetchOptions = {
            ...repo,
            remote,
            singleBranch: false,
            tags: true,
            prune: false,
        };

        if (shouldUnshallow) {
            fetchOptions.depth = MAX_UNSHALLOW_DEPTH;
        }

        await this.withTimeout('fetch', signal => git.fetch({ ...fetchOptions, signal }));
    }

    /**
     * @param {string[]} args
     * @returns {Promise<string>}
     */
    async revparse(args) {
        const parsedArgs = Array.isArray(args) ? args.map(String) : [String(args)];
        const [first, second] = parsedArgs;

        if (first === '--short' && second) {
            return (await this.resolveRef(second)).slice(0, 7);
        }

        if (first === '--abbrev-ref' && second === 'HEAD') {
            return (await git.currentBranch(this.getRepoOptions())) ?? 'HEAD';
        }

        if (first === '--abbrev-ref' && second === '@{u}') {
            return this.getTrackingBranchName();
        }

        if (first === '--is-shallow-repository') {
            const gitDir = this.resolveGitDir(this.getBaseDirOrThrow());
            return gitDir && fs.existsSync(path.join(gitDir, 'shallow')) ? 'true' : 'false';
        }

        if (first === '--show-toplevel') {
            return this.getBaseDirOrThrow();
        }

        if (parsedArgs.length === 1) {
            return this.resolveRef(first);
        }

        throw new Error(`Unsupported rev-parse arguments for isomorphic backend: ${parsedArgs.join(' ')}`);
    }

    /**
     * @param {string[]} args
     * @returns {Promise<string>}
     */
    async show(args) {
        const parsedArgs = Array.isArray(args) ? args.map(String) : [String(args)];
        const expectedPrefix = ['-s', '--format=%ci'];
        const matchesFormat = parsedArgs.length === 3 && expectedPrefix.every((value, index) => parsedArgs[index] === value);

        if (!matchesFormat) {
            throw new Error(`Unsupported show arguments for isomorphic backend: ${parsedArgs.join(' ')}`);
        }

        const oid = await this.resolveRef(parsedArgs[2]);
        const { commit } = await git.readCommit({ ...this.getRepoOptions(), oid });

        return `${this.formatCommitDateCI(commit)}\n`;
    }

    /**
     * @param {{ from: string, to: string }} args
     * @returns {Promise<{all: Array<{hash: string, message: string, date: string, refs: string, body: string, author_name: string, author_email: string}>, latest: object | null, total: number}>}
     */
    async log(args) {
        const fromOid = await this.resolveRef(args.from);
        const toOid = await this.resolveRef(args.to);

        if (fromOid === toOid) {
            return {
                all: [],
                latest: null,
                total: 0,
            };
        }

        try {
            const isToDescendedFromFrom = await git.isDescendent({
                ...this.getRepoOptions(),
                oid: toOid,
                ancestor: fromOid,
            });

            if (!isToDescendedFromFrom) {
                const isFromDescendedFromTo = await git.isDescendent({
                    ...this.getRepoOptions(),
                    oid: fromOid,
                    ancestor: toOid,
                });

                if (isFromDescendedFromTo) {
                    return {
                        all: [],
                        latest: null,
                        total: 0,
                    };
                }
            }
        } catch {
            // Fall back to full set-difference behavior for shallow/unusual histories.
        }

        const fromHistory = await this.collectReachableCommitSet(fromOid);
        const entries = await this.collectCommitsExcluding(toOid, fromHistory);
        const all = [];

        for (const entry of entries) {
            all.push({
                hash: entry.oid,
                message: entry.commit.message.split('\n')[0] ?? '',
                date: new Date(this.toTimestampMs(Number(entry.commit.committer.timestamp))).toISOString(),
                refs: '',
                body: '',
                author_name: entry.commit.author.name,
                author_email: entry.commit.author.email,
            });
        }

        return {
            all,
            latest: all[0] ?? null,
            total: all.length,
        };
    }

    /**
     * @param {boolean} [verbose]
     */
    async getRemotes(verbose = false) {
        const remotes = await git.listRemotes(this.getRepoOptions());

        if (!verbose) {
            return remotes.map(remote => ({ name: remote.remote }));
        }

        return remotes.map(remote => ({
            name: remote.remote,
            refs: {
                fetch: remote.url,
                push: remote.pushurl ?? remote.url,
            },
        }));
    }

    /**
     * @param {string=} remote
     * @param {string=} branch
     */
    async pull(remote = DEFAULT_REMOTE, branch) {
        const repo = this.getRepoOptions();
        const currentBranch = branch || await git.currentBranch(repo);

        if (!currentBranch) {
            throw new Error('Cannot pull while HEAD is detached.');
        }

        const authorName = await git.getConfig({ ...repo, path: 'user.name' });
        const authorEmail = await git.getConfig({ ...repo, path: 'user.email' });
        const pullOptions = {
            ...repo,
            remote,
            ref: currentBranch,
            singleBranch: false,
        };

        if (authorName && authorEmail) {
            pullOptions.fastForwardOnly = false;
            pullOptions.author = { name: String(authorName), email: String(authorEmail) };
        } else {
            pullOptions.fastForwardOnly = true;
        }

        await this.withTimeout('pull', signal => git.pull({ ...pullOptions, signal }));
    }

    /**
     * @param {string} url
     * @param {string} localPath
     * @param {{ '--depth'?: number | string, '--branch'?: string }} [options]
     */
    async clone(url, localPath, options = {}) {
        const depthValue = Number.parseInt(String(options['--depth'] ?? ''), 10);
        const branch = options['--branch'] ? String(options['--branch']) : undefined;

        await this.withTimeout('clone', signal => git.clone({
            fs,
            http,
            dir: localPath,
            url,
            depth: Number.isFinite(depthValue) ? depthValue : undefined,
            ref: branch,
            singleBranch: Boolean(branch),
            signal,
        }));
    }

    /**
     * @param {string[]} options
     * @returns {Promise<{ all: string[], branches: Record<string, { current: boolean, linkedWorkTree: boolean, name: string, commit: string, label: string }>, current: string }>}
     */
    async branch(options = []) {
        if (Array.isArray(options) && options.includes('-r')) {
            const remotePattern = options.find(option => option.includes('/')) ?? `${DEFAULT_REMOTE}/*`;
            const remoteName = remotePattern.split('/')[0] || DEFAULT_REMOTE;
            const branchNames = (await git.listBranches({ ...this.getRepoOptions(), remote: remoteName })).filter(name => name && name !== 'HEAD');
            let currentTracking = '';

            try {
                currentTracking = await this.getTrackingBranchName();
            } catch {
                currentTracking = '';
            }

            return this.buildBranchSummary(
                branchNames.map(name => `${remoteName}/${name}`),
                currentTracking,
            );
        }

        const currentBranch = await git.currentBranch(this.getRepoOptions()) ?? '';
        const branchNames = await git.listBranches(this.getRepoOptions());
        return this.buildBranchSummary(branchNames, currentBranch);
    }

    /**
     * @returns {Promise<{ all: string[], branches: Record<string, { current: boolean, linkedWorkTree: boolean, name: string, commit: string, label: string }>, current: string }>}
     */
    async branchLocal() {
        const currentBranch = await git.currentBranch(this.getRepoOptions()) ?? '';
        const branchNames = await git.listBranches(this.getRepoOptions());
        return this.buildBranchSummary(branchNames, currentBranch);
    }

    /**
     * @param {string[]} branchNames
     * @param {string} currentBranch
     * @returns {Promise<{ all: string[], branches: Record<string, { current: boolean, linkedWorkTree: boolean, name: string, commit: string, label: string }>, current: string }>}
     */
    async buildBranchSummary(branchNames, currentBranch) {
        const filteredBranchNames = branchNames.filter(Boolean);
        const branches = {};

        for (const branchName of filteredBranchNames) {
            let commit = '';

            try {
                commit = await this.resolveRef(branchName);
            } catch {
                commit = '';
            }

            branches[branchName] = {
                current: branchName === currentBranch,
                linkedWorkTree: false,
                name: branchName,
                commit,
                label: branchName,
            };
        }

        return {
            all: filteredBranchNames,
            branches,
            current: currentBranch,
        };
    }

    /**
     * @param {string} branchName
     */
    async checkout(branchName) {
        await git.checkout({
            ...this.getRepoOptions(),
            ref: branchName,
        });
    }

    /**
     * @param {string} localBranch
     * @param {string} startPoint
     */
    async checkoutBranch(localBranch, startPoint) {
        const repo = this.getRepoOptions();
        const oid = await this.resolveRef(startPoint);

        await git.writeRef({
            ...repo,
            ref: `refs/heads/${localBranch}`,
            value: oid,
            force: true,
        });

        if (startPoint.includes('/')) {
            const [remote, ...branchParts] = startPoint.split('/');
            const remoteBranch = branchParts.join('/');

            if (remote && remoteBranch) {
                await git.setConfig({
                    ...repo,
                    path: `branch.${localBranch}.remote`,
                    value: remote,
                });

                await git.setConfig({
                    ...repo,
                    path: `branch.${localBranch}.merge`,
                    value: `refs/heads/${remoteBranch}`,
                });
            }
        }

        await git.checkout({
            ...repo,
            ref: localBranch,
        });
    }

    /**
     * @param {string[]} args
     */
    async remote(args) {
        const parsedArgs = Array.isArray(args) ? args.map(String) : [String(args)];

        if (parsedArgs[0] !== 'set-branches' || parsedArgs.length < 3) {
            throw new Error(`Unsupported remote arguments for isomorphic backend: ${parsedArgs.join(' ')}`);
        }

        const remoteName = parsedArgs[1];
        const branchSelector = parsedArgs[2];
        const refspec = branchSelector === '*'
            ? `+refs/heads/*:refs/remotes/${remoteName}/*`
            : `+refs/heads/${branchSelector}:refs/remotes/${remoteName}/${branchSelector}`;

        await git.setConfig({
            ...this.getRepoOptions(),
            path: `remote.${remoteName}.fetch`,
            value: refspec,
        });
    }
}

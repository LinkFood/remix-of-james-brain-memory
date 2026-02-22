/**
 * GitHub API utility for jac-code-agent
 *
 * Pure fetch-based wrapper. No npm deps. Uses GITHUB_PAT from env.
 * Safety: commitFiles rejects if branch is main or master.
 */

const GITHUB_API = 'https://api.github.com';

function getHeaders(): Record<string, string> {
  const token = Deno.env.get('GITHUB_PAT');
  if (!token) throw new Error('GITHUB_PAT not configured');
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// Files that should never be read
const SECRET_PATTERNS = [
  /^\.env/,
  /\.pem$/,
  /\.key$/,
  /credentials/i,
  /secret/i,
];

export function isSecretFile(path: string): boolean {
  const basename = path.split('/').pop() || '';
  return SECRET_PATTERNS.some(p => p.test(basename));
}

/**
 * Get the full file tree of a repo (recursive)
 */
export async function getRepoTree(
  owner: string,
  repo: string,
  ref = 'main'
): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub tree API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.tree || [])
    .filter((item: { type: string }) => item.type === 'blob')
    .map((item: { path: string }) => item.path);
}

/**
 * Get file content from a repo
 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref = 'main'
): Promise<{ path: string; content: string; sha: string }> {
  if (isSecretFile(path)) {
    throw new Error(`Refused to read secret file: ${path}`);
  }

  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub content API failed for ${path} (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  if (data.size > 50 * 1024) {
    throw new Error(`File too large: ${path} (${data.size} bytes, max 50KB)`);
  }

  const content = atob(data.content.replace(/\n/g, ''));
  return { path, content, sha: data.sha };
}

/**
 * Create a new branch from an existing one
 */
export async function createBranch(
  owner: string,
  repo: string,
  baseBranch: string,
  newBranch: string
): Promise<void> {
  // Get the SHA of the base branch
  const refUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`;
  const refRes = await fetch(refUrl, { headers: getHeaders() });

  if (!refRes.ok) {
    const text = await refRes.text();
    throw new Error(`Failed to get base branch ref (${refRes.status}): ${text.slice(0, 200)}`);
  }

  const refData = await refRes.json();
  const sha = refData.object.sha;

  // Create the new branch
  const createUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/refs`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      ref: `refs/heads/${newBranch}`,
      sha,
    }),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Failed to create branch (${createRes.status}): ${text.slice(0, 200)}`);
  }
}

export interface FileChange {
  path: string;
  content: string;
}

/**
 * Atomic multi-file commit via Git Data API
 * Safety: rejects if branch is main or master
 */
export async function commitFiles(
  owner: string,
  repo: string,
  branch: string,
  files: FileChange[],
  message: string
): Promise<string> {
  // Safety guard
  const lower = branch.toLowerCase();
  if (lower === 'main' || lower === 'master') {
    throw new Error(`SAFETY: Refused to commit directly to ${branch}. Use a feature branch.`);
  }

  if (files.length === 0) {
    throw new Error('No files to commit');
  }

  if (files.length > 10) {
    throw new Error(`Too many files (${files.length}). Max 10 per session.`);
  }

  const headers = getHeaders();

  // 1. Get the current commit SHA of the branch
  const refUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`;
  const refRes = await fetch(refUrl, { headers });
  if (!refRes.ok) throw new Error(`Failed to get branch ref: ${refRes.status}`);
  const refData = await refRes.json();
  const parentSha = refData.object.sha;

  // 2. Get the tree SHA of the parent commit
  const commitUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${parentSha}`;
  const commitRes = await fetch(commitUrl, { headers });
  if (!commitRes.ok) throw new Error(`Failed to get parent commit: ${commitRes.status}`);
  const commitData = await commitRes.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for each file
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];

  for (const file of files) {
    const blobUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`;
    const blobRes = await fetch(blobUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    });
    if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path}: ${blobRes.status}`);
    const blobData = await blobRes.json();
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobData.sha });
  }

  // 4. Create a new tree
  const treeUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/trees`;
  const treeRes = await fetch(treeUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });
  if (!treeRes.ok) throw new Error(`Failed to create tree: ${treeRes.status}`);
  const treeData = await treeRes.json();

  // 5. Create a new commit
  const newCommitUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/commits`;
  const newCommitRes = await fetch(newCommitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message,
      tree: treeData.sha,
      parents: [parentSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(`Failed to create commit: ${newCommitRes.status}`);
  const newCommitData = await newCommitRes.json();

  // 6. Update the branch ref to point to the new commit
  const updateRefUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`;
  const updateRes = await fetch(updateRefUrl, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommitData.sha }),
  });
  if (!updateRes.ok) throw new Error(`Failed to update ref: ${updateRes.status}`);

  return newCommitData.sha;
}

/**
 * Create a pull request
 */
export async function createPR(
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<{ number: number; url: string }> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ title, body, head, base }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create PR (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return { number: data.number, url: data.html_url };
}

/**
 * Check if a repo exists and is accessible
 */
export async function repoExists(owner: string, repo: string): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}`;
  const res = await fetch(url, { headers: getHeaders() });
  return res.ok;
}

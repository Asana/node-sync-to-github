var GitHubApi = require('github');
var path = require('path');
var util = require('util');
var Promise = require('bluebird');
var _ = require('lodash');

var fs = Promise.promisifyAll(require('fs-extra'));

/**
 * Make a request to sync the contents of a flat directory to a repo on GitHub.
 *
 * @param options Options for the sync request.
 * @option {GitHubApi} [github] API client. If unspecified, one will be
 *     created by default (in which case `oauthToken` should be specified)
 * @option {string} [oauthToken] Token to authorize the `github` client with.
 *     Not necessary if client is already authorized.
 * @option {string} user Name of github user that owns the repo being accessed.
 * @option {string} repo Name of the github repo to access.
 * @option {string} localPath Root path in the local filesystem from which to
 *     sync files. Note that no substructure is supported; this must just be
 *     a flat directory of files (nested dirs will not be synced).
 * @option {string} repoPath Relative path in the `repo` to sync files.
 *     This path will be overwritten with the contents of `localPath`.
 *     The parent of this path must already exist in repo.
 * @option {string} message Message for committed changes
 * @option {boolean} [preserveRepoFiles] Perform only additive changes to the
 *     target repo, i.e. do not delete existing files or directories inside
 *     `repoPath`.
 * @option {string} [branch] Name of branch in repo to sync to, defaults
 *     to `master`. This branch must already exist in repo unless `createBranch`
 *     is true.
 * @option {string} [baseBranch] Name of branch in repo that is the base
 *     for `branch`. This branch must already exist in repo.
 *     Defaults to `master`.
 * @option {boolean} [createBranch] Create `branch` if it does not already
 *     exist, by forking from `baseBranch`.
 * @option {boolean} [createPullRequest] If true, after syncing create a pull
 *     request to merge from `branch` to `baseBranch`.
 * @option {boolean} [debug] If true, provide debugging output to console.
 * @return {Promise}
 */
function syncToGitHub(options) {
  debug(options, 'Sync github started');
  validateOptions(options);

  // Set up way to connect to github
  var github = initClient(options);
  var gitData = wrapGitData(github, options);

  // Split path into path parts, removing empty nodes (as one might find
  // at the beginning or end)
  var pathParts = _.compact(options.repoPath.split('/'));

  // TODO: support subdirectories and filtering by doing a traversal
  // and building blobs and trees as we visit. That algo may look somewhat
  // different from this one.

  return Promise.resolve().then(function() {

    return getBranchOrNull(gitData, options.branch).then(function(branch) {
      if (branch) {
        return branch;
      } else if (options.createBranch) {
        return createBranch(gitData, options.branch, options.baseBranch);
      } else {
        throw new Error(
            util.format('Branch `%s` does not exist', options.branch));
      }
    }).then(function(branch) {
      return getLatestCommit(gitData, branch).then(function(commit) {
        return gitData('getTree',
            { sha: commit.tree.sha }).then(function(rootTree) {
              return existingTreesForPath(gitData, rootTree, pathParts);
            }).then(function(treesForPath) {
              return createNewTreeForPath(gitData, options, treesForPath,
                  pathParts);
            }).then(function(newRootTree) {
              if (newRootTree.sha === commit.tree.sha) {
                debug(options, 'No changes to tree, not committing anything');
              } else {
                return commitChanges(gitData, options, commit, newRootTree)
                    .then(function() {
                      if (options.createPullRequest) {
                        return createPullRequest(github, options);
                      }
                    });
              }
            });
      });
    });
  }).then(function() {
    debug(options, 'Sync to github complete!');
  });
}

/**
 * Validate options and throw an error if anything is wrong.
 *
 * @param options {Object} Options for sync request
 */
function validateOptions(options) {
  options.branch = options.branch || 'master';
  options.baseBranch = options.baseBranch || 'master';

  if (typeof(options.user) !== 'string') {
    throw new Error('Must pass owner of repo in `user`');
  }
  if (typeof(options.repo) !== 'string') {
    throw new Error('Must pass repo name in `repo`');
  }
  if (typeof(options.localPath) !== 'string') {
    throw new Error('Must pass local path to sync from in `localPath`');
  }
  if (typeof(options.repoPath) !== 'string') {
    throw new Error('Must pass path within repo to sync to in `repoPath`');
  }
  if (typeof(options.message) !== 'string') {
    throw new Error('Must pass commit message in `message`');
  }
  if (options.baseBranch === options.branch) {
    if (options.createBranch) {
      throw new Error(
          util.format(
              'Cannot create `branch` if it is the same as `baseBranch` (%s)',
              options.branch));
    }
    if (options.createPullRequest) {
      throw new Error(
          util.format(
                  'Cannot create pull request when `branch` and ' +
                  '`baseBranch` are the same (%s).', options.branch));
    }
  }
}

/**
 * Maybe log a message to console, depending on debug settings in `options`.
 *
 * @param options {Object} Options for sync request
 * @param message {string} Message to log. Will automatically be passed as
 *     the first arg to `util.format`, with other args.
 */
function debug(options, message) {
  if (options.debug) {
    console.log(util.format.apply(util, [].slice.call(arguments, 1)));
  }
}

/**
 * Ensure the github client is initialized for the sync request.
 *
 * @param options {Object} Options passed for sync request
 * @returns {GitHubApi}
 */
function initClient(options) {
  var github = options.github;
  if (!github) {
    github = new GitHubApi({
      version: '3.0.0',
      protocol: 'https',
      host: 'api.github.com'
    });
  }
  if (options.oauthToken) {
    github.authenticate({
      type: 'oauth',
      token: options.oauthToken
    });
  }
  return github;
}

/**
 * Create a convenient wrapper around the `gitdata` endpoint for the github api,
 * that automatically passes the user and repo and is promisified.
 *
 * @param github {GitHubApi}
 * @param options {Object} Options for the sync request
 * @returns {function(string, object): Promise} A function to make a call to
 *     the github api. Takes the name of the call and the parameters, and
 *     returns a promise for its results.
 */
function wrapGitData(github, options) {
  var gitdata = Promise.promisifyAll(github.gitdata);
  return function gitData(name, params) {
    // Promisified methods by default have `Async` appended to their names.
    var method = gitdata[name + 'Async'];
    var realParams = _.merge({
      user: options.user,
      repo: options.repo
    }, params);
    var loggedParams = _.merge({}, params);
    // We use this client to send blobs and sometimes they are big;
    // avoid dumping blob content to log.
    if (typeof(loggedParams.content) === 'string') {
      loggedParams.content =
          '[' + loggedParams.content.length + ' characters]';
    }
    debug(options, 'gitdata', name, loggedParams);
    return method.call(gitdata, realParams);
  }
}


/**
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param localPath {string} Local path to read all files from.
 * @param [baseTree] {object} Tree to base the new tree on.
 * @returns {Promise<Object>} Tree in github for the newly created directory
 *     in the repository.
 */
function createTreeForSingleDir(gitData, localPath, baseTree) {
  // For each file in the directory
  var pathExists = {};
  return fs.readdirAsync(localPath).then(function(filenames) {
    return Promise.all(filenames.map(function(filename) {
      var fullPath = path.join(localPath, filename);

      // Stat the file
      return fs.statAsync(fullPath).then(function(stat) {

        // For now we just support a single flat directory.
        // TODO: change this to a visitor (with filters) that does a traversal
        // and creates blobs for files and trees for non-empty directories.
        if (stat.isDirectory()) {
          console.warn(
                  'Directory encountered, will not recurse into: ' + fullPath);
          return null;
        }

        // Create a blob for the file and return the tree entry for it.
        return fs.readFileAsync(fullPath).then(function(content) {
          return gitData('createBlob', {
            content: content.toString('utf-8'),
            encoding: 'utf-8'
          });
        }).then(function(response) {
          pathExists[filename] = true;
          return {
            path: filename,
            mode: '100644',  // TODO: propagate local mode correctly?
            type: 'blob',
            sha: response.sha
          }
        });
      });
    }));
  }).then(function(children) {
    if (baseTree) {
      // We're basing this tree off an existing one. Bring in any children from
      // the base that were not created in the new tree.
      children = children.concat(
          treeChildrenForCreateRequest(baseTree).filter(function(child) {
            return !pathExists[child.path];
          }));
    }
    return gitData('createTree', { tree: children });
  });
}

/**
 * Recursively create the the new git tree that effects changes along the
 * given path.
 *
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param options {object} Options for the sync request
 * @param treesForPath {object[]} Array of trees from root to deepest change,
 *     with the last element being the newest change.
 * @param pathParts {string[]} Array of path components from root to deepest.
 * @returns {Promise<Object>} Tree in github for the newly created directory
 *     in the repository.
 */
function createNewTreeForPath(gitData, options, treesForPath, pathParts) {
  return Promise.resolve().then(function() {
    var existingTree = null;
    if (treesForPath.length === pathParts.length + 1) {
      // If there is a tree for every part of the path, there will be one more
      // tree than part because there is no path part for the root.
      debug(options, 'Target path already exists');
      existingTree = treesForPath.splice(-1)[0];
    }
    if (treesForPath.length === pathParts.length) {
      return createTreeForSingleDir(
          gitData, options.localPath,
          (existingTree && options.preserveRepoFiles) ? existingTree : null);
    } else {
      throw new Error(
              'Could not find existing parent dir for repo path: ' +
              options.repoPath);
    }
  }).then(function(newTargetTree) {
    treesForPath.push(newTargetTree);
    return createTreeForPath(gitData, treesForPath, pathParts);
  });
}

/**
 * Recursively create the the new git tree that effects changes along the
 * given path.
 *
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param treesForPath {object[]} Array of trees from root to deepest change,
 *     with the last element being the newest change.
 * @param pathParts {string[]} Array of path components from root to deepest.
 * @returns {Promise<Object>} Tree in github for the newly created directory
 *     in the repository.
 */
function createTreeForPath(gitData, treesForPath, pathParts) {
  // Take the second-to-last tree, copy it, but replace the reference named
  // by the last path with a reference to the last tree.
  var lastTree = treesForPath.slice(-1)[0];
  var parentTree = treesForPath.slice(-2)[0];
  var lastPath = pathParts.slice(-1)[0];
  if (lastPath === undefined) {
    // We are at the root. No need to do more. Return the root.
    return lastTree;
  }

  var child = _.find(parentTree.tree, function(child) {
    return child.path === lastPath;
  });
  if (!child) {
    child = { path: lastPath };
    parentTree.tree.push(child);
  }
  child.type = 'tree';
  child.mode = '040000';
  child.sha = lastTree.sha;

  var newTreeChildren = treeChildrenForCreateRequest(parentTree);
  return gitData('createTree', { tree: newTreeChildren }).then(function(newTree) {
    return createTreeForPath(
        gitData,
        treesForPath.slice(0, -2).concat([newTree]),
        pathParts.slice(0, -1));
  });
}

/**
 * @param tree {object} A tree object as received from github
 * @returns {object[]} An array of tree entries that are appropriate to
 *     upload to github for a tree creation request.
 */
function treeChildrenForCreateRequest(tree) {
  return tree.tree.map(function(child) {
    return _.pick(child, ['path', 'mode', 'type', 'sha']);
  });
}

/**
 * Commit a new tree to the branch to make the sync effective.
 *
 * @param gitData {function}
 * @param options {object}
 * @param latestCommit {object} latest commit on branch
 * @param newRootTree {object} new root tree to commit
 * @returns {Promise} Complete when changes are committed
 */
function commitChanges(gitData, options, latestCommit, newRootTree) {
  // TODO: perhaps do something more sophisticated / robust to collisions
  // like branch and merge.
  return Promise.resolve().then(function() {
    return gitData('createCommit', {
      message: options.message,
      tree: newRootTree.sha,
      parents: [latestCommit.sha]
    });
  }).then(function(newCommit) {
    return gitData('updateReference', {
      ref: 'heads/' + options.branch,
      sha: newCommit.sha
    });
  });
}

/**
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param branch {Object} Branch record to get the latest commit for.
 * @returns {Promise<Object>} Commit record for the given branch
 */
function getLatestCommit(gitData, branch) {
  return gitData('getCommit', { sha: branch.object.sha });
}

/**
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param branchName {string} Name of the branch to get.
 * @returns {Promise<Object|null>} Ref record for the given branch or null if
 *     not found
 */
function getBranchOrNull(gitData, branchName) {
  return gitData('getReference', { ref: 'heads/' + branchName }).then(function(branch) {
    return branch;
  }).catch(function(error) {
    if (error.code === 404) {
      return null;
    } else {
      throw error;
    }
  });
}

/**
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param branchName {string} Name of the branch to get the latest commit for.
 * @param baseBranchName {string} Name of the branch to base the new one on.
 * @returns {Promise<Object>} Commit record from get for the given branch
 */
function createBranch(gitData, branchName, baseBranchName) {
  return gitData('getReference', { ref: 'heads/' + baseBranchName }).then(function(baseBranch) {
    return gitData('createReference', {
      ref: 'refs/heads/' + branchName,
      sha: baseBranch.object.sha
    });
  });
}

/**
 * Fetch tree information along a path, as far as it exists.
 *
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param rootTree {object} Tree from git representing the root of the repo.
 * @param pathParts {string[]} Components of the path to get the trees for.
 * @param [treeCache] {object} Cache of path -> tree so we don't have to fetch
 *     the same tree multiple times from git. May be initialized to empty.
 * @returns {Promise<Object[]>} Trees from root to the deepest existing
 *     component of `pathParts`. Will have a length <= `pathParts.length + 1`
 *     because it will also contain the root tree (`pathParts` does not).
 */
function existingTreesForPath(gitData, rootTree, pathParts, treeCache) {
  treeCache = treeCache || {};
  treeCache[rootTree.sha] = rootTree;
  if (pathParts.length === 0) {
    // No where left to go!
    return [rootTree];
  }

  // Find the tree child corresponding to the next path component
  var path = pathParts[0];
  var remainingPath = pathParts.slice(1);
  var nextTreeInfo = _.find(rootTree.tree, function(child) {
    return child.type === 'tree' && child.path === path;
  });
  if (!nextTreeInfo) {
    // This is the end of the line.
    return [rootTree];
  }

  // Recurse to move to the next level of depth
  return getTree(gitData, treeCache, nextTreeInfo.sha).then(function(nextTree) {
    return existingTreesForPath(gitData, nextTree, remainingPath, treeCache);
  }).then(function(subTree) {
    return [rootTree].concat(subTree);
  });
}

/**
 * Get the record for a tree given its SHA.
 *
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param treeCache {object} Cache of path -> tree
 * @param treeSha {string} SHA of the tree to get
 * @returns {object} Git tree representing the given sha, either pulled from
 *     the cache or from github.
 */
function getTree(gitData, treeCache, treeSha) {
  if (treeCache[treeSha]) {
    // Found in cache - return a copy
    return Promise.resolve(_.merge({}, treeCache[treeSha]));
  } else {
    // Fetch from github
    return gitData('getTree', { sha: treeSha });
  }
}

/**
 * @param github {GitHubApi}
 * @param options {Object} options for sync request
 * @returns {Promise} Complete once the pull request is created
 */
function createPullRequest(github, options) {
  var lines = options.message.split('\n');
  var pullRequestsAsync = Promise.promisify(
      github.pullRequests.create, github.pullRequests);
  return pullRequestsAsync({
    user: options.user,
    repo: options.repo,
    title: lines[0],
    body: lines.slice(1).join('\n'),
    base: options.baseBranch,
    head: options.branch
  }).catch(function(err) {
    if (typeof(err) === 'object' && typeof(err.message) !== 'undefined' &&
        /already exists/.test(err.message)) {
      // This is ok, it's a legitimate way to fail if we've already got
      // an outstanding pull request.
      // TODO: update pull request with new message?
      debug(
          options,
          'Pull request from branch %s to %s already exists, ignoring.',
          options.branch, options.baseBranch);
    } else {
      throw err;
    }
  });
}

module.exports = {
  syncToGitHub: syncToGitHub,
  existingTreesForPath: existingTreesForPath
};

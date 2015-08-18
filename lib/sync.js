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
 * @option {string} [branch] Name of branch in repo to sync to, defaults
 *     to `master`. This branch must already exist in repo.
 * @option {string} [pullToBranch] If defined, after syncing create a pull
 *     request to merge from `branch` to this branch.
 * @option {boolean} [debug] If true, provide debugging output to console.
 * @return {Promise}
 */
function syncToGitHub(options) {
  debug('Sync github started', options);
  validateOptions(options);

  // Set up way to connect to github
  var github = initClient(options);
  var gitData = wrapGitData(github, options);

  // Split path into path parts, removing empty nodes (as one might find
  // at the beginning or end)
  var pathParts = _.compact(options.repoPath.split('/'));

  return Promise.resolve().then(function() {
    // Create a tree holding the files
    // TODO: support subdirectories and filtering by doing a traversal
    // and building blobs and trees as we visit
    return createTreeForSingleDir(gitData, options.localPath);
  }).then(function(newTargetTree) {
    return getLatestCommit(gitData, options.branch).then(function(commit) {
      var treeCache = {};
      return gitData('getTree', { sha: commit.tree.sha }).then(function(rootTree) {
        return parentTreesForPath(gitData, treeCache, rootTree, pathParts);
      }).then(function(treesForPath) {
        treesForPath.push(newTargetTree);
        return createTreeForPath(gitData, treesForPath, pathParts);
      }).then(function(newRootTree) {
        return gitData('createCommit', {
          message: options.message,
          tree: newRootTree.sha,
          parents: [commit.sha]
        });
      }).then(function(newCommit) {
        return gitData('updateReference', {
          ref: 'heads/' + options.branch,
          sha: newCommit.sha
        });
      }).then(function() {
        if (options.pullToBranch) {
          return createPullRequest(github, options);
        }
      });
    });
  }).then(function() {
    debug('Sync to github complete!');
  });
}

/**
 * Validate options and throw an error if anything is wrong.
 *
 * @param options {Object} Options for sync request
 */
function validateOptions(options) {
  options.branch = options.branch || 'master';

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
  if (typeof(options.pullToBranch) !== 'string') {
    if (options.pullToBranch === options.branch) {
      throw new Error(
          'Pull request to branch named in `pullToBranch` must be' +
              ' different from `branch` being synced to: ' +
              options.pullToBranch);
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
 * that automatically passed the user and repo and is promisified.
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
    var method = gitdata[name + 'Async'];
    var realParams = _.merge({
      user: options.user,
      repo: options.repo
    }, params);
    var loggedParams = _.merge({}, params);
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
 * @returns {Promise<Object>} Tree in github for the newly created directory
 *     in the repository.
 */
function createTreeForSingleDir(gitData, localPath) {
  // For each file in the directory
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
    return gitData('createTree', { tree: children });
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

  var newTreeChildren = parentTree.tree.map(function(child) {
    return _.pick(child, ['path', 'mode', 'type', 'sha']);
  });
  return gitData('createTree', { tree: newTreeChildren }).then(function(newTree) {
    return createTreeForPath(
        gitData,
        treesForPath.slice(0, -2).concat([newTree]),
        pathParts.slice(0, -1));
  });
}

/**
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param branchName {string} Name of the branch to get the latest commit for.
 * @returns {Promise<Object>} Commit record from get for the given branch
 */
function getLatestCommit(gitData, branchName) {
  return gitData('getReference', { ref: 'heads/' + branchName }).then(function(branch) {
    return gitData('getCommit', { sha: branch.object.sha });
  });
}


/**
 * Fetch tree information along a path.
 *
 * @param gitData {function} Wrapper to call the `gitdata` endpoint.
 * @param treeCache {object} Cache of path -> tree so we don't have to fetch
 *     the same tree multiple times from git. May be initialized to empty.
 * @param rootTree {object} Tree from git representing the root of the repo.
 * @param pathParts {string[]} Components of the path to get the trees for.
 * @returns {Promise<Object[]>} Trees from root to the parent of the deepest
 *     component of `pathParts`.
 */
function parentTreesForPath(gitData, treeCache, rootTree, pathParts) {
  treeCache[rootTree.sha] = rootTree;
  if (pathParts.length <= 1) {
    // We stop here. The deepest component may not even exist, but we don't
    // need to return it since we're getting parents.
    return [rootTree];
  }

  // Find the tree child corresponding to the next path component
  var path = pathParts[0];
  var remainingPath = pathParts.slice(1);
  var nextTreeInfo = _.find(rootTree.tree, function(child) {
    return child.type === 'tree' && child.path === path;
  });
  if (!nextTreeInfo) {
    throw new Error('Path not found in tree: ' + path);
  }

  // Recurse to move to the next level of depth
  return getTree(gitData, treeCache, nextTreeInfo.sha).then(function(nextTree) {
    return parentTreesForPath(gitData, treeCache, nextTree, remainingPath);
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
    base: options.pullToBranch,
    head: options.branch
  }).catch(function(err) {
    if (typeof(err.errors) === 'object' &&
        /already exists/.test(err.errors[0].message)) {
      // This is ok, it's a legitimate way to fail if we've already got
      // an outstanding pull request.
      // TODO: update pull request with new message
      console.log('Pull request for branch already exists, ignoring.');
    } else {
      throw err;
    }
  });
}

module.exports = {
  syncToGitHub: syncToGitHub,
  parentTreesForPath: parentTreesForPath
};

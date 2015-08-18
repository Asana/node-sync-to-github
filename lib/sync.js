// TODO
var GitHubApi = require('github');
var path = require('path');
var util = require('util');
var Promise = require('bluebird');
var _ = require('lodash');

var fs = Promise.promisifyAll(require('fs-extra'));

/**
 * @param options
 * @option {GitHubApi} [github] API client
 * @option {string} [oauthToken] Token to authorize the client with
 * @option {string} user
 * @option {string} repo
 * @option {string} localPath
 * @option {string} repoPath
 * @option {string} [branch]
 * @option {string} [pullToBranch]
 * @option {boolean} [debug]
 * @option {boolean} [debugGitHub]
 */
function syncToGitHub(options) {
  var github = initClient(options);
  var gitData = wrapGitData(github, options);

  var branch = options.branch || 'master';
  // Split into path parts, removing empty nodes
  var pathParts = _.compact(options.repoPath.split('/'));

  return Promise.resolve().then(function() {
    // TODO: support subdirectories and filtering by doing a traversal
    // and building blobs and trees as we visit
    return createTreeForSingleDir(gitData, options.localPath);
  }).then(function(newTargetTree) {

    debug(options, 'Created target tree', newTargetTree.sha);

    return getLatestCommit(gitData, branch).then(function(commit) {
      var treeCache = {};
      return gitData('getTree', { sha: commit.tree.sha }).then(function(rootTree) {
        return parentTreesForPath(gitData, treeCache, rootTree, pathParts);
      }).then(function(treesForPath) {
        treesForPath.push(newTargetTree);
        return createTreesForPath(gitData, treesForPath, pathParts);
      }).then(function(newRootTree) {
        return gitData('createCommit', {
          message: 'xcxc',
          tree: newRootTree.sha,
          parents: [commit.sha]
        });
      }).then(function(newCommit) {
        return gitData('updateReference', {
          ref: 'heads/' + branch,
          sha: newCommit.sha
        });
      }).then(function(head) {
        console.log(head);
      });
    });
  });
}

function debug(options, message) {
  if (options.debug) {
    console.log(util.format.apply(util, [].slice.call(arguments, 1)));
  }
}

function initClient(options) {
  var github = options.github;
  if (!github) {
    github = new GitHubApi({
      version: '3.0.0',
      debug: !!options.debugGitHub,
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


function wrapGitData(github, options) {
  var gitdata = Promise.promisifyAll(github.gitdata);
  return function gitData(name, params) {
    var method = gitdata[name + 'Async'];
    var realParams = _.merge({
      user: options.user,
      repo: options.repo
    }, params);
    debug(options, 'gitdata', name, params);
    return method.call(gitdata, realParams);
  }
}


/**
 * @param gitData
 * @param localPath {string} Local path to read all files in.
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
            mode: '100644',  // TODO: propagate mode correctly
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



function createTreesForPath(gitData, treesForPath, pathParts) {
  // Recursively, from the deepest level to the root, create trees.

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
    return createTreesForPath(
        gitData,
        treesForPath.slice(0, -2).concat([newTree]),
        pathParts.slice(0, -1));
  });
}


function getLatestCommit(gitData, branchName) {
  return gitData('getReference', { ref: 'heads/' + branchName }).then(function(branch) {
    return gitData('getCommit', { sha: branch.object.sha });
  });
}


function parentTreesForPath(gitData, treeCache, rootTree, pathParts) {
  treeCache[rootTree.sha] = rootTree;
  if (pathParts.length <= 1) {
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


function getTree(gitData, treeCache, treeSha) {
  if (treeCache[treeSha]) {
    // Found in cache - return a copy
    return Promise.resolve(_.merge({}, treeCache[treeSha]));
  } else {
    // Fetch from github
    return gitData('getTree', { sha: treeSha });
  }
}

module.exports = {
  syncToGitHub: syncToGitHub,
  parentTreesForPath: parentTreesForPath
};

var sync = require('./lib/sync');

module.exports = sync.syncToGitHub;

//xcxc
sync.syncToGitHub({
  oauthToken: process.env.ASANA_GITHUB_TOKEN,
  user: 'Asana',
  repo: 'node-sync-to-github',
  repoPath: 'dist/abc/def',
  localPath: 'test',
  branch: 'test',
  debug: true
});


module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  // `.claude/` holds agent rules and, more importantly, the git worktrees
  // Claude Code creates by default. A worktree there is a second copy of the
  // whole repo, so without this pattern every suite runs twice.
  testPathIgnorePatterns: ['/node_modules/', '/e2e/', '/\\.claude/'],
};

// Commit messages follow Conventional Commits (https://www.conventionalcommits.org):
//   <type>(<optional scope>): <summary>
// e.g. `feat(bots): lead moving targets with the RPG`, `fix: …`, `docs: …`.
// Checked locally by husky (.husky/commit-msg) and on GitHub (commitlint workflow).
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Bodies here are often long, wrapped prose; keep lines readable, not strict.
    'body-max-line-length': [1, 'always', 100],
  },
};

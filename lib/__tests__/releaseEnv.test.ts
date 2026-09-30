import { cleanChildEnv } from '../../scripts/release/env';

// What `npm run release:desktop` hands the script on the owner's Mac (npm
// 11.16, measured): the owner's own environment, plus npm's configuration
// and context, plus node_modules/.bin of the shared checkout and of every
// directory above it, and npm's node-gyp-bin, at the front of PATH.
const SHARED = '/Users/david.lambl/repos/nestworth';
const OWN_PATH = [
  '/Users/david.lambl/.local/share/fnm/node-versions/v24.18.0/installation/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
];
const NPM_PATH = [
  `${SHARED}/node_modules/.bin`,
  '/Users/david.lambl/repos/node_modules/.bin',
  '/Users/david.lambl/node_modules/.bin',
  '/Users/node_modules/.bin',
  '/node_modules/.bin',
  '/Users/david.lambl/.local/share/fnm/node-versions/v24.18.0/installation/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
];
const OWN = {
  HOME: '/Users/david.lambl',
  USER: 'david.lambl',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/var/folders/q5/T/',
  SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
};
const UNDER_NPM_RUN = {
  ...OWN,
  PATH: [...NPM_PATH, ...OWN_PATH].join(':'),
  COLOR: '1',
  EDITOR: 'vi',
  INIT_CWD: SHARED,
  NODE: '/Users/david.lambl/.local/share/fnm/node-versions/v24.18.0/installation/bin/node',
  npm_command: 'run',
  npm_config_allow_scripts: '@github/keytar,node-pty',
  npm_config_cache: '/Users/david.lambl/.npm',
  npm_config_global_prefix: '/Users/david.lambl/.local/share/fnm',
  npm_config_globalconfig: '/Users/david.lambl/.local/share/fnm/etc/npmrc',
  npm_config_init_module: '/Users/david.lambl/.npm-init.js',
  npm_config_local_prefix: SHARED,
  npm_config_loglevel: 'notice',
  npm_config_node_gyp: '/x/node-gyp.js',
  npm_config_noproxy: '',
  npm_config_npm_version: '11.16.0',
  npm_config_prefix: '/Users/david.lambl/.local/share/fnm',
  npm_config_user_agent: 'npm/11.16.0 node/v24.18.0 darwin arm64',
  npm_config_userconfig: '/Users/david.lambl/.npmrc',
  npm_config_dry_run: 'true',
  npm_config_force: 'true',
  npm_execpath: '/x/npm-cli.js',
  npm_lifecycle_event: 'release:desktop',
  npm_lifecycle_script: 'node scripts/release-desktop.js',
  npm_node_execpath: '/x/node',
  npm_package_json: `${SHARED}/package.json`,
  npm_package_name: 'nestworth',
  npm_package_version: '1.2.0',
  NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
};

describe('cleanChildEnv', () => {
  const clean = cleanChildEnv(UNDER_NPM_RUN);

  it('drops every variable npm hands its script, whatever its case', () => {
    expect(Object.keys(clean).sort()).toEqual(
      [...Object.keys(OWN), 'PATH'].sort()
    );
    expect(clean).not.toHaveProperty('npm_config_allow_scripts');
    expect(clean).not.toHaveProperty('npm_config_local_prefix');
    expect(clean).not.toHaveProperty('INIT_CWD');
    expect(clean).not.toHaveProperty('NPM_CONFIG_REGISTRY');
  });

  it("keeps the owner's own environment as it is", () => {
    expect(clean).toMatchObject(OWN);
  });

  it('takes the node_modules/.bin and node-gyp-bin entries npm prepended off PATH', () => {
    expect(clean.PATH).toBe(OWN_PATH.join(':'));
  });

  it('sets what the build needs on top', () => {
    expect(
      cleanChildEnv(UNDER_NPM_RUN, {
        APPLE_KEYCHAIN_PROFILE: 'nestworth',
        TMPDIR: '/private/build/tmp',
      })
    ).toMatchObject({
      APPLE_KEYCHAIN_PROFILE: 'nestworth',
      TMPDIR: '/private/build/tmp',
      HOME: '/Users/david.lambl',
    });
  });

  it('changes nothing it is given, and copes without a PATH', () => {
    const before = JSON.stringify(UNDER_NPM_RUN);
    cleanChildEnv(UNDER_NPM_RUN, { TMPDIR: '/elsewhere' });
    expect(JSON.stringify(UNDER_NPM_RUN)).toBe(before);
    expect(cleanChildEnv({ HOME: '/h' })).toEqual({ HOME: '/h' });
  });
});

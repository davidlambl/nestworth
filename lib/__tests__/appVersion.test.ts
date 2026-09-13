import appJson from '../../app.json';
import { appVersionLabel } from '../appVersion';

describe('appVersionLabel', () => {
  it('shows the configured version', () => {
    expect(appVersionLabel({ version: '1.1.0' })).toBe('Nestworth v1.1.0');
  });

  it('ignores whitespace around the version', () => {
    expect(appVersionLabel({ version: ' 2.0.0\n' })).toBe('Nestworth v2.0.0');
  });

  it('falls back instead of rendering a bare "Nestworth v"', () => {
    const unknown = 'Nestworth (version unknown)';
    expect(appVersionLabel(null)).toBe(unknown);
    expect(appVersionLabel({})).toBe(unknown);
    expect(appVersionLabel({ version: '' })).toBe(unknown);
    expect(appVersionLabel({ version: '   ' })).toBe(unknown);
  });

  it("reads app.json's expo.version by default", () => {
    expect(appVersionLabel()).toBe(`Nestworth v${appJson.expo.version}`);
  });
});

/**
 * REGRESSION — defect workout-timer-20260803-1 / ticket wt-ios-appearance-locked-light.
 *
 * The app ships the canonical in-app Appearance control (System / Light / Dark,
 * `src/theme/AppearanceToggle.tsx`). It works by asking the OS for a scheme
 * (`Appearance.setColorScheme`), which `useColorScheme()` — and therefore every
 * themed surface via `useTheme()` — reads back.
 *
 * That whole chain is neutralised on iOS by ONE native config line: an
 * `expo.userInterfaceStyle` pinned to a fixed value writes `UIUserInterfaceStyle`
 * into Info.plist, and the OS then forces the app to that appearance no matter
 * what the JS asks for. workout-timer shipped pinned to "light", so picking Dark
 * (or System, on a dark device) did nothing on iOS while working on Android — a
 * settings control that visibly does nothing, and a cross-platform parity break.
 * It was measured on the device matrix: every iOS "dark" cell rendered at
 * luminance ~214-244 while its Android twin rendered ~51.
 *
 * So this file guards BOTH halves of the chain, because either one alone passes
 * while the feature is broken:
 *   1. the native config must not pin the appearance (the half that regressed);
 *   2. the JS must actually resolve a dark palette when the user picks Dark
 *      (the half the config was silently overriding).
 */

import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Text } from 'react-native';
import { render, screen, userEvent } from '@testing-library/react-native';

jest.mock('expo-font', () => ({
  useFonts: () => [true, null],
  isLoaded: () => true,
  loadAsync: () => Promise.resolve(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

/**
 * A simulated OS appearance service — the boundary this feature talks to.
 *
 * Two stock jest fakes have to be replaced to test this honestly: RN mocks
 * `useColorScheme` to the constant 'light', and its real `Appearance` never
 * emits a change event in the test environment. Both would make the assertions
 * below vacuous. So the OS is modelled here (it stores the scheme, resolves
 * 'unspecified' back to the device setting, and notifies listeners the way the
 * native module does) and everything above it — themePreference, useTheme,
 * AppearanceToggle — is the real code under test.
 */
// (Plain JS inside the factories — jest forbids out-of-scope references there,
// and a TS annotation counts as one.)
jest.mock('react-native/Libraries/Utilities/Appearance', () => {
  let deviceScheme = 'light';
  let scheme = 'light';
  const listeners: Array<Function> = [];
  return {
    getColorScheme: () => scheme,
    setColorScheme: (next: string | null | undefined) => {
      scheme = next == null || next === 'unspecified' ? deviceScheme : next;
      listeners.forEach((l) => l({ colorScheme: scheme }));
    },
    addChangeListener: (l: Function) => {
      listeners.push(l);
      return {
        remove: () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    /** Test-only: what the device itself is set to, i.e. what "System" means. */
    __setDeviceScheme: (next: string) => {
      deviceScheme = next;
    },
  };
});
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => {
  const { useSyncExternalStore } = require('react');
  const Appearance = require('react-native/Libraries/Utilities/Appearance');
  return {
    __esModule: true,
    default: () =>
      useSyncExternalStore(
        (onChange: () => void) => {
          const sub = Appearance.addChangeListener(onChange);
          return () => sub.remove();
        },
        () => Appearance.getColorScheme(),
      ),
  };
});

import { AppearanceToggle } from '../AppearanceToggle';
import { useTheme, lightColors, darkColors } from '../colors';
import { setThemePreference } from '../themePreference';

// ---------------------------------------------------------------------------
// 1. The native config must leave the appearance to the OS.
// ---------------------------------------------------------------------------

type ExpoConfig = {
  userInterfaceStyle?: string;
  ios?: { userInterfaceStyle?: string };
  android?: { userInterfaceStyle?: string };
};

function expoConfig(): ExpoConfig {
  const raw = readFileSync(join(__dirname, '../../../app.json'), 'utf8');
  return JSON.parse(raw).expo as ExpoConfig;
}

/**
 * Only "automatic" leaves the appearance to the OS on iOS. ABSENT IS NOT
 * NEUTRAL: `@expo/prebuild-config`'s `getUserInterfaceStyle()` reads
 * `ios.userInterfaceStyle ?? userInterfaceStyle ?? 'light'`, so deleting the key
 * writes `UIUserInterfaceStyle = Light` into Info.plist just the same. Removing
 * the line would look like a fix and reproduce the bug.
 */
function resolveIos(cfg: ExpoConfig): string {
  return cfg.ios?.userInterfaceStyle ?? cfg.userInterfaceStyle ?? 'light';
}
function isPinned(value: string | undefined): boolean {
  return (value ?? 'light') !== 'automatic';
}

describe('native appearance config (defect workout-timer-20260803-1)', () => {
  it('does not pin userInterfaceStyle at the root', () => {
    const cfg = expoConfig();
    expect({ where: 'expo.userInterfaceStyle', value: cfg.userInterfaceStyle ?? '(absent)' }).toEqual({
      where: 'expo.userInterfaceStyle',
      value: 'automatic',
    });
    expect(isPinned(cfg.userInterfaceStyle)).toBe(false);
  });

  it('does not pin userInterfaceStyle per platform either', () => {
    const cfg = expoConfig();
    // A per-platform key beats the root one, so an ios override would re-break it.
    expect(cfg.ios?.userInterfaceStyle ?? 'automatic').toBe('automatic');
    expect(cfg.android?.userInterfaceStyle ?? 'automatic').toBe('automatic');
  });

  it('resolves to Automatic through the same rule the iOS build uses', () => {
    // Guards the near-miss fix: deleting the key entirely reads as "light" to
    // @expo/prebuild-config and reproduces the bug with nothing visible in the file.
    expect(resolveIos(expoConfig())).toBe('automatic');
    expect(resolveIos({})).toBe('light');
    expect(resolveIos({ userInterfaceStyle: 'automatic', ios: { userInterfaceStyle: 'light' } })).toBe('light');
  });

  it('leaves the in-app control able to reach every appearance on both platforms', () => {
    // The parity statement in one assertion: with no pin, what the user picks is
    // what the OS is asked for, identically on iOS and Android. With a pin, iOS
    // collapses every choice onto the pinned value while Android still varies —
    // exactly the 214-244 vs 51 luminance split the device matrix measured.
    const cfg = expoConfig();
    const pin = (platform: 'ios' | 'android') => {
      const value = cfg[platform]?.userInterfaceStyle ?? cfg.userInterfaceStyle;
      return isPinned(value) ? (value ?? 'light') : null;
    };
    const effective = (platform: 'ios' | 'android', picked: 'light' | 'dark') => pin(platform) ?? picked;

    for (const picked of ['light', 'dark'] as const) {
      expect(effective('ios', picked)).toBe(picked);
      expect(effective('ios', picked)).toBe(effective('android', picked));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The JS half: picking Dark must actually resolve the dark palette.
// ---------------------------------------------------------------------------

function PaletteProbe() {
  const { c, isDark } = useTheme();
  return <Text>{`${isDark ? 'dark' : 'light'}:${c.bg}`}</Text>;
}

const FakeAppearance = require('react-native/Libraries/Utilities/Appearance') as {
  __setDeviceScheme: (s: 'light' | 'dark') => void;
};

async function mountToggle() {
  await render(
    <>
      <PaletteProbe />
      <AppearanceToggle />
    </>
  );
  return userEvent.setup();
}

describe('in-app Appearance control resolves the palette', () => {
  beforeEach(() => {
    FakeAppearance.__setDeviceScheme('light');
    setThemePreference('system');
  });

  it('renders the light palette by default and the dark palette once Dark is picked', async () => {
    const user = await mountToggle();

    expect(screen.getByText(`light:${lightColors.bg}`)).toBeTruthy();

    await user.press(screen.getByRole('radio', { name: 'Dark' }));

    // Not merely "a different string" — the actual dark paper token. If the
    // palettes ever collapse onto one another the app has no dark mode at all.
    expect(screen.getByText(`dark:${darkColors.bg}`)).toBeTruthy();
    expect(darkColors.bg).not.toBe(lightColors.bg);
  });

  it('hands control back to the OS when System is picked', async () => {
    const user = await mountToggle();

    await user.press(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByText(`dark:${darkColors.bg}`)).toBeTruthy();

    await user.press(screen.getByRole('radio', { name: 'System' }));
    expect(screen.getByText(`light:${lightColors.bg}`)).toBeTruthy();
  });

  it('follows a dark device when System is picked — the other half of the defect', async () => {
    FakeAppearance.__setDeviceScheme('dark');
    const user = await mountToggle();

    await user.press(screen.getByRole('radio', { name: 'Light' }));
    expect(screen.getByText(`light:${lightColors.bg}`)).toBeTruthy();

    await user.press(screen.getByRole('radio', { name: 'System' }));
    expect(screen.getByText(`dark:${darkColors.bg}`)).toBeTruthy();
  });
});

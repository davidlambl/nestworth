import { router, type Href } from 'expo-router';

// Where a press takes a person, safe against a press that lands twice before
// the first has been rendered (#242), and with one copy of a screen in the
// root Stack.
//
// expo-router 58 does not navigate at once: router.push and router.back put
// an intent in React state, and an effect dispatches it a render later. Every
// queued PUSH adds a route and every GO_BACK pops one, so two presses inside
// one render -- a double tap on an account card, a row, or a header item
// (native on iOS since #249, one press per tap like a drawn button) -- opened
// the screen twice, the lower copy hidden behind the top one and one Back
// more to leave; and two presses of a sheet's Cancel closed the register
// under the sheet too. lib/__tests__/screenNavigation.test.ts measures each
// function here with expo-router's own router, Stack and tabs.

/**
 * Opens `href` from a press. `router.navigate`, not `router.push`: a NAVIGATE
 * to the screen already on top -- the same route with the same path params --
 * updates that screen instead of adding one, so a second press lands on the
 * screen the first one opened, whether it arrives in the same render or after
 * the first has landed. Another screen is still opened on top (another
 * account's register, another row), and a press after Back opens the screen
 * afresh. Everywhere else navigate pushes as push did: no press that calls
 * this opens the screen it is pressed on.
 */
export function openScreen(href: Href): void {
  router.navigate(href);
}

/** The part of a screen's `navigation` (useNavigation()) closeScreen uses. */
export type ClosingScreen = {
  getState(): { key: string } | undefined;
  dispatch(action: { type: string; target?: string }): void;
};

/**
 * Closes the screen `navigation` belongs to, from a press on that screen (a
 * sheet's Cancel, Import's Done) or once its save has finished. The back is
 * sent by the screen, which names itself as the action's source, and
 * addressed to the screen's own Stack: the Stack pops that screen and nothing
 * else, and once it is gone a second request finds no source and is a
 * handled no-op -- in the same render, during the dismiss animation, or from
 * a save that finishes after Cancel (New Transaction's photo upload goes on
 * once its sheet is cancelled) -- where router.back popped whatever was on
 * top, the register under the sheet included.
 */
export function closeScreen(navigation: ClosingScreen): void {
  // CommonActions.goBack()'s action, with the target the Stack honours.
  navigation.dispatch({ type: 'GO_BACK', target: navigation.getState()?.key });
}

/**
 * Takes a person who has just signed in to the Accounts tab. `router.dismissTo`,
 * not `router.replace`: when the tabs are below the sign-in screen it returns
 * to them and closes everything above them, where a replace left the old tabs
 * -- and a register open over them -- mounted under a second copy (two tab
 * bar controllers on iOS, the lower one hidden; Back or an edge swipe brought
 * it back). They are below it after a link to it while signed in, after the
 * signed-out redirect from a screen over the tabs (a register), and at a
 * launch at the sign-in screen (the root Stack's anchor puts them there).
 * Only after the redirect from the tabs themselves are they not below it;
 * then it takes the sign-in screen's place, as the replace did.
 * A change of account still mounts the tabs afresh: the tabs layout is keyed
 * by the account (#177). The URL, not the group: since each tab is a group of
 * its own (#248), typed routes know "/" and "/(tabs)/(home)", not "/(tabs)".
 */
export function returnToTabs(): void {
  router.dismissTo('/');
}

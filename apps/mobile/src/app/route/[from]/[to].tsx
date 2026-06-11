/**
 * /route/[from]/[to] — compatibility redirect.
 *
 * The standalone route screen is gone (nav-mode variant D): navigation now
 * renders as the HOME screen in nav mode, addressed by `/?nav=<from>:<to>`.
 * Existing deep links (shared URLs, J10/J13 journeys) keep working — they
 * land here and redirect, preserving the ?avoid=stairs accessibility param.
 * `Redirect` replaces this entry, so back never returns to the redirector.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function RouteRedirect() {
  const { from, to, avoid } = useLocalSearchParams<{
    from: string;
    to: string;
    avoid?: string;
  }>();
  return (
    <Redirect
      href={{
        pathname: '/',
        params: { nav: `${from}:${to}`, ...(avoid === 'stairs' ? { avoid: 'stairs' } : null) },
      }}
    />
  );
}

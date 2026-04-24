import { useEffect, useState } from 'react';

export const PUBLIC_PATHS = ['/', '/about', '/privacy-policy', '/terms', '/contact', '/data-deletion'] as const;

export function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePathname(): string {
  const [path, setPath] = useState<string>(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

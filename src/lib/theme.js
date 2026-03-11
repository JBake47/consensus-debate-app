export const THEME_STORAGE_KEY = 'theme_mode';
export const DEFAULT_THEME_MODE = 'dark';

export function normalizeThemeMode(value) {
  return value === 'light' ? 'light' : DEFAULT_THEME_MODE;
}

export function getStoredThemeMode() {
  if (typeof window === 'undefined') return DEFAULT_THEME_MODE;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME_MODE;
    try {
      return normalizeThemeMode(JSON.parse(raw));
    } catch {
      return normalizeThemeMode(raw);
    }
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function applyThemeMode(themeMode) {
  if (typeof document === 'undefined') return;
  const normalized = normalizeThemeMode(themeMode);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;
}

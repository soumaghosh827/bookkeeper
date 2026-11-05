// Applies theme + density tokens (see styles/tokens.css). Add a theme = add a [data-theme] block + an entry here.
export const THEMES = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }] as const
export const DENSITIES = [{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }] as const

export function applyTheme(theme?: string | null, density?: string | null) {
  const root = document.documentElement
  root.dataset.theme = THEMES.some((t) => t.id === theme) ? theme! : 'light'
  root.dataset.density = DENSITIES.some((d) => d.id === density) ? density! : 'comfortable'
}
export const rowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 34

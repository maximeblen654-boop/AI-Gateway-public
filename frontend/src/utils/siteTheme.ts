import { ref } from 'vue'

export const siteThemeStorageKey = 'upstream-model-catalog-theme'
export const sidebarStyleStorageKey = 'site-sidebar-style'
export const yellowSidebarStyleStorageKey = 'site-yellow-sidebar-style'

export const siteThemeOptions = [
  { value: 'yellow', color: '#ffdf91' },
  { value: 'blue', color: '#80bdff' },
  { value: 'pink', color: '#efbccb' },
  { value: 'green', color: '#abd9bd' },
  { value: 'lavender', color: '#b7a8eb' }
] as const

export type SiteTheme = (typeof siteThemeOptions)[number]['value']
export type SidebarStyle = 'botanical' | 'whale' | 'whale_girl'
export type YellowSidebarStyle = 'osmanthus' | 'lion' | 'scholar' | 'robot'

export const siteTheme = ref<SiteTheme>('yellow')
export const sidebarStyle = ref<SidebarStyle>('botanical')
export const yellowSidebarStyle = ref<YellowSidebarStyle>('osmanthus')

function isSiteTheme(value: string | null): value is SiteTheme {
  return siteThemeOptions.some((option) => option.value === value)
}

function applySiteTheme(theme: SiteTheme) {
  siteTheme.value = theme
  document.documentElement.dataset.siteTheme = theme
}

function applySidebarStyle(style: SidebarStyle) {
  sidebarStyle.value = style
  document.documentElement.dataset.sidebarStyle = style
}

function applyYellowSidebarStyle(style: YellowSidebarStyle) {
  yellowSidebarStyle.value = style
  document.documentElement.dataset.yellowSidebarStyle = style
}


export function initSiteTheme() {
  let savedTheme: string | null = null
  try {
    savedTheme = window.localStorage.getItem(siteThemeStorageKey)
  } catch {
    // A blocked storage API must not prevent the site from rendering.
  }
  const legacyWhale = savedTheme === 'blue-whale'
  applySiteTheme(savedTheme === 'purple' ? 'lavender' : legacyWhale ? 'blue' : isSiteTheme(savedTheme) ? savedTheme : 'yellow')
  let savedSidebarStyle: string | null = null
  try {
    savedSidebarStyle = window.localStorage.getItem(sidebarStyleStorageKey)
  } catch {
    // Keep the botanical sidebar if storage is unavailable.
  }
  let chosenSidebarStyle: SidebarStyle = 'botanical'
  if (legacyWhale || savedSidebarStyle === 'whale') chosenSidebarStyle = 'whale'
  else if (savedSidebarStyle === 'whale_girl') chosenSidebarStyle = 'whale_girl'
  applySidebarStyle(chosenSidebarStyle)
  let savedYellowSidebarStyle: string | null = null
  try {
    savedYellowSidebarStyle = window.localStorage.getItem(yellowSidebarStyleStorageKey)
  } catch {
    // Keep the osmanthus artwork if storage is unavailable.
  }
  applyYellowSidebarStyle(
    savedYellowSidebarStyle === 'lion' || savedYellowSidebarStyle === 'scholar' || savedYellowSidebarStyle === 'robot'
      ? savedYellowSidebarStyle
      : 'osmanthus'
  )
  if (legacyWhale) {
    try {
      window.localStorage.setItem(siteThemeStorageKey, 'blue')
      window.localStorage.setItem(sidebarStyleStorageKey, 'whale')
    } catch {
      // The migrated choice still applies for this session.
    }
  }
}

export function setSiteTheme(theme: SiteTheme) {
  applySiteTheme(theme)
  try {
    window.localStorage.setItem(siteThemeStorageKey, theme)
  } catch {
    // The selected skin still applies for this session.
  }
}

export function setSidebarStyle(style: SidebarStyle) {
  applySidebarStyle(style)
  try {
    window.localStorage.setItem(sidebarStyleStorageKey, style)
  } catch {
    // The sidebar choice still applies for this session.
  }
}

export function setYellowSidebarStyle(style: YellowSidebarStyle) {
  applyYellowSidebarStyle(style)
  try {
    window.localStorage.setItem(yellowSidebarStyleStorageKey, style)
  } catch {
    // The selected artwork still applies for this session.
  }
}

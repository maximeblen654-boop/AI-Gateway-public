import { afterEach, describe, expect, it } from 'vitest'
import { initSiteTheme, setSidebarStyle, setSiteTheme, setYellowSidebarStyle, sidebarStyle, sidebarStyleStorageKey, siteTheme, siteThemeStorageKey, yellowSidebarStyle, yellowSidebarStyleStorageKey } from '../siteTheme'

describe('site theme', () => {
  afterEach(() => {
    window.localStorage.removeItem(siteThemeStorageKey)
    window.localStorage.removeItem(sidebarStyleStorageKey)
    window.localStorage.removeItem(yellowSidebarStyleStorageKey)
    document.documentElement.removeAttribute('data-site-theme')
    document.documentElement.removeAttribute('data-sidebar-style')
    document.documentElement.removeAttribute('data-yellow-sidebar-style')
    siteTheme.value = 'yellow'
    sidebarStyle.value = 'botanical'
    yellowSidebarStyle.value = 'osmanthus'
  })

  it('restores the catalog selection on every route through the document root', () => {
    window.localStorage.setItem(siteThemeStorageKey, 'blue')
    initSiteTheme()
    expect(siteTheme.value).toBe('blue')
    expect(document.documentElement.dataset.siteTheme).toBe('blue')
  })

  it('updates the root and persisted preference together, including legacy purple', () => {
    window.localStorage.setItem(siteThemeStorageKey, 'purple')
    initSiteTheme()
    expect(siteTheme.value).toBe('lavender')
    setSiteTheme('green')
    expect(document.documentElement.dataset.siteTheme).toBe('green')
    expect(window.localStorage.getItem(siteThemeStorageKey)).toBe('green')
  })

  it('switches only the blue sidebar artwork and persists that choice', () => {
    setSiteTheme('blue')
    setSidebarStyle('whale')
    expect(document.documentElement.dataset.siteTheme).toBe('blue')
    expect(document.documentElement.dataset.sidebarStyle).toBe('whale')
    expect(window.localStorage.getItem(sidebarStyleStorageKey)).toBe('whale')
    sidebarStyle.value = 'botanical'
    initSiteTheme()
    expect(sidebarStyle.value).toBe('whale')
    setSiteTheme('pink')
    expect(sidebarStyle.value).toBe('whale')
    expect(document.documentElement.dataset.siteTheme).toBe('pink')
  })

  it('restores the whale-girl sidebar selection without adding a site theme', () => {
    setSiteTheme('blue')
    setSidebarStyle('whale_girl')
    sidebarStyle.value = 'botanical'
    initSiteTheme()
    expect(siteTheme.value).toBe('blue')
    expect(sidebarStyle.value).toBe('whale_girl')
    expect(document.documentElement.dataset.sidebarStyle).toBe('whale_girl')
  })

  it('migrates the previously saved sixth theme into blue plus the whale sidebar', () => {
    window.localStorage.setItem(siteThemeStorageKey, 'blue-whale')
    initSiteTheme()
    expect(siteTheme.value).toBe('blue')
    expect(sidebarStyle.value).toBe('whale')
    expect(window.localStorage.getItem(siteThemeStorageKey)).toBe('blue')
  })

  it('keeps yellow character choice separate from blue artwork and restores it', () => {
    setYellowSidebarStyle('scholar')
    setSidebarStyle('whale')
    expect(window.localStorage.getItem(yellowSidebarStyleStorageKey)).toBe('scholar')
    setSiteTheme('blue')
    yellowSidebarStyle.value = 'osmanthus'
    initSiteTheme()
    expect(yellowSidebarStyle.value).toBe('scholar')
    expect(sidebarStyle.value).toBe('whale')
    expect(document.documentElement.dataset.yellowSidebarStyle).toBe('scholar')
  })
})

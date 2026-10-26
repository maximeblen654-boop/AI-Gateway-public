package service

// StudioModelCatalogAccountIdentity exposes the existing native model-list
// identity as a one-way hash. Callers must not return or retain the temporary
// credential inputs. Native API model aliases are excluded by the shared helper.
func StudioModelCatalogAccountIdentity(a *Account) (string, error) {
	if a == nil {
		return "", ErrAccountNilInput
	}
	return studioModelCatalogAccountIdentity(a)
}

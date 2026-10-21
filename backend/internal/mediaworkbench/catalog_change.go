package mediaworkbench

import (
	"sort"
	"strings"
)

const CatalogChangeKey = "studio_model_catalog_change_v1"

const catalogChangeMaxModels = 20
const catalogChangeMaxModelBytes = 256

// CatalogChangeFor compares two successful observations without changing either
// catalog. Missing IDs mean only that this response did not return them; they
// are not evidence of a removal or rename by the supplier.
func CatalogChangeFor(previous, current *Catalog, last *CatalogChange) (*CatalogChange, error) {
	if current == nil {
		return nil, ErrInvalid
	}
	currentModels := catalogModelSet(current.Models)
	if len(currentModels) == 0 || current.Source != "upstream" || current.SyncedAt == "" {
		return nil, ErrInvalid
	}
	// Legacy/changed identities have no comparable baseline. A successful new
	// identity must also clear a notice belonging to the old credential owner.
	if previous == nil || previous.Source != "upstream" || previous.SyncedAt == "" ||
		current.AccountIdentitySHA256 == "" || previous.AccountIdentitySHA256 != current.AccountIdentitySHA256 {
		return nil, nil
	}
	previousModels := catalogModelSet(previous.Models)
	if len(previousModels) == 0 {
		return nil, nil
	}
	added := catalogModelDifference(currentModels, previousModels)
	missing := catalogModelDifference(previousModels, currentModels)
	if len(added) == 0 && len(missing) == 0 {
		if last != nil && last.SchemaVersion == 1 && last.AccountIdentitySHA256 == current.AccountIdentitySHA256 {
			// Keep the original event time/counts, including when reading an old
			// abnormal notice. Only its display lists are bounded on every write.
			change := *last
			change.AddedModels = boundedCatalogChangeModels(last.AddedModels)
			change.MissingModels = boundedCatalogChangeModels(last.MissingModels)
			change.Truncated = last.Truncated || len(change.AddedModels) != change.AddedCount || len(change.MissingModels) != change.MissingCount
			return &change, nil
		}
		return nil, nil
	}
	change := &CatalogChange{
		SchemaVersion: 1, AccountIdentitySHA256: current.AccountIdentitySHA256,
		DetectedAt: current.SyncedAt, PreviousSyncedAt: previous.SyncedAt,
		AddedCount: len(added), MissingCount: len(missing),
	}
	change.AddedModels = boundedCatalogChangeModels(added)
	change.MissingModels = boundedCatalogChangeModels(missing)
	change.Truncated = len(change.AddedModels) != change.AddedCount || len(change.MissingModels) != change.MissingCount
	return change, nil
}

func catalogModelSet(models []string) map[string]struct{} {
	set := make(map[string]struct{}, len(models))
	for _, model := range models {
		if model = strings.TrimSpace(model); model != "" {
			set[model] = struct{}{}
		}
	}
	return set
}

func catalogModelDifference(models, baseline map[string]struct{}) []string {
	difference := make([]string, 0)
	for model := range models {
		if _, found := baseline[model]; !found {
			difference = append(difference, model)
		}
	}
	sort.Strings(difference)
	return difference
}

func boundedCatalogChangeModels(models []string) []string {
	bounded := make([]string, 0, min(len(models), catalogChangeMaxModels))
	for _, model := range models {
		if len(model) > catalogChangeMaxModelBytes {
			continue // Never display a partial ID that could identify another model.
		}
		if len(bounded) == catalogChangeMaxModels {
			break
		}
		bounded = append(bounded, model)
	}
	return bounded
}

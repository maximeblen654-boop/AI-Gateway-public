package mediaworkbench

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestExecutionEditsSaveAndReloadPreserveProductsAndPrices(t *testing.T) {
	for _, withBlank := range []bool{false, true} {
		name := "one-product"
		if withBlank {
			name = "configured-and-blank"
		}
		t.Run(name, func(t *testing.T) {
			s, r := validatorFixture(t)
			products := []Product{validProduct()}
			products[0].Capabilities.Count = Range{1, 10}
			if withBlank {
				blank := validProduct()
				blank.ProductID = "blank"
				blank.PricingRules = nil
				products = append(products, blank)
			}
			initial, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: products})
			must(t, err)
			products = initial.Config.Draft.Products
			commercial := func(products []Product) string {
				cloned := append([]Product(nil), products...)
				for i := range cloned {
					cloned[i].AdapterConfig.Execution = nil
					cloned[i].AdapterConfig.EditExecution = nil
				}
				b, _ := json.Marshal(cloned)
				return string(b)
			}
			before := commercial(products)
			for _, edit := range []bool{false, true} {
				for _, stepTemplate := range []ImageExecutionConfig{
					{Mode: ImageExecutionNativeMulti, MaxOutputImages: 10},
					{Mode: ImageExecutionNativeMulti, MaxOutputImages: 1},
					{Mode: ImageExecutionNativeMulti, MaxOutputImages: 2},
					{Mode: ImageExecutionSingle, MaxOutputImages: 1},
				} {
					step := stepTemplate
					submitted := append([]Product(nil), products...)
					config := ImageExecutionConfig{Mode: step.Mode, MaxOutputImages: step.MaxOutputImages, Provider: step.Provider}
					if edit {
						submitted[0].AdapterConfig.EditExecution = &config
					} else {
						submitted[0].AdapterConfig.Execution = &config
					}
					request, _ := json.Marshal(submitted)
					var requestSnapshot []Product
					_ = json.Unmarshal(request, &requestSnapshot)
					d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: submitted})
					must(t, err)
					reloaded, err := s.Detail(t.Context(), 7)
					must(t, err)
					if !reflect.DeepEqual(d.Config.Draft.Products, reloaded.Config.Draft.Products) || commercial(reloaded.Config.Draft.Products) != before {
						t.Fatalf("execution edit changed product collection/specs/prices: edit=%t step=%+v draft=%+v", edit, step, reloaded.Config.Draft.Products)
					}
					actual := reloaded.Config.Draft.Products[0]
					if edit {
						want := requestSnapshot[0].AdapterConfig.EditExecution
						if actual.AdapterConfig.EditExecution == nil || want == nil || *actual.AdapterConfig.EditExecution != *want {
							t.Fatalf("edit execution changed during save/reload: submitted=%+v reloaded=%+v", want, actual.AdapterConfig.EditExecution)
						}
					} else {
						want := requestSnapshot[0].AdapterConfig.Execution
						if actual.AdapterConfig.Execution == nil || want == nil || *actual.AdapterConfig.Execution != *want {
							t.Fatalf("generation execution changed during save/reload: submitted=%+v reloaded=%+v", want, actual.AdapterConfig.Execution)
						}
					}
					products = reloaded.Config.Draft.Products
					if r.a.Config.Published != nil || r.a.Config.Sales.Enabled {
						t.Fatal("draft edit changed publication or sales")
					}
					selected := requestSnapshot[0].AdapterConfig.Execution
					if edit {
						selected = requestSnapshot[0].AdapterConfig.EditExecution
					}
					t.Logf("edit=%t mode=%s max=%d request=%s response/reload products=%d", edit, selected.Mode, selected.MaxOutputImages, request, len(reloaded.Config.Draft.Products))
				}
			}
		})
	}
}

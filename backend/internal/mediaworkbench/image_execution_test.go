package mediaworkbench

import (
	"reflect"
	"testing"
)

func TestSystemTenImagesUsesSeparateGenerationAndEditLimits(t *testing.T) {
	for _, limit := range []int{1, 2, 5} {
		mode := ImageExecutionSingle
		if limit > 1 {
			mode = ImageExecutionNativeMulti
		}
		resolved := ResolvedImageOffer{Spec: Spec{Count: 10}, Offer: Offer{ResolvedConfig: ImageConfig{Execution: &ImageExecutionConfig{Mode: mode, MaxOutputImages: limit}}}}
		for _, refs := range []int{0, 1} {
			resolved.Spec.Images = refs
			plan, err := PublishedImageExecution(resolved)
			if err != nil {
				t.Fatal(err)
			}
			wantLimit := limit
			if refs > 0 {
				wantLimit = 1
			}
			if len(plan.Units) != 10/wantLimit {
				t.Fatalf("limit=%d refs=%d units=%v", limit, refs, plan.Units)
			}
			for i, u := range plan.Units {
				if u.Index != i || u.OutputCount != wantLimit || u.OutputOffset != i*wantLimit {
					t.Fatalf("unexpected unit: %+v", u)
				}
			}
		}
	}
	r := ResolvedImageOffer{Spec: Spec{Count: 5}, Offer: Offer{ResolvedConfig: ImageConfig{Execution: &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 2}, EditExecution: &ImageExecutionConfig{Mode: ImageExecutionSingle, MaxOutputImages: 1}}}}
	for refs, want := range [][]int{{2, 2, 1}, {1, 1, 1, 1, 1}} {
		r.Spec.Images = refs
		p, err := PublishedImageExecution(r)
		if err != nil {
			t.Fatal(err)
		}
		got := []int{}
		for _, u := range p.Units {
			got = append(got, u.OutputCount)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("refs=%d got=%v want=%v", refs, got, want)
		}
	}
}

func TestPlanImageExecutionDefaultsToSingle(t *testing.T) {
	p, err := PlanImageExecution(ImageConfig{}, 3)
	if err != nil || p.Mode != ImageExecutionSingle || len(p.Units) != 3 {
		t.Fatalf("default plan = %+v, err=%v", p, err)
	}
	for i, u := range p.Units {
		if u.Index != i || u.OutputOffset != i || u.OutputCount != 1 {
			t.Fatalf("unit %d = %+v", i, u)
		}
	}
}

func TestPlanImageExecutionNativeMultiBatches(t *testing.T) {
	p, err := PlanImageExecution(ImageConfig{Execution: &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 2}}, 5)
	if err != nil || len(p.Units) != 3 {
		t.Fatalf("plan = %+v, err=%v", p, err)
	}
	want := []int{2, 2, 1}
	for i, u := range p.Units {
		if u.OutputCount != want[i] || u.OutputOffset != []int{0, 2, 4}[i] {
			t.Fatalf("unit %d = %+v", i, u)
		}
	}
	for _, max := range []int{2, 5} {
		p, err := PlanImageExecution(ImageConfig{Execution: &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: max}}, 5)
		if err != nil || p.Units[0].OutputCount != max || (max == 2 && len(p.Units) != 3) || (max == 5 && len(p.Units) != 1) {
			t.Fatalf("native max %d plan = %+v, err=%v", max, p, err)
		}
	}
}

func TestPlanImageExecutionRejectsUnverifiedAsyncAndInvalidLimits(t *testing.T) {
	for _, config := range []ImageConfig{
		{Execution: &ImageExecutionConfig{Mode: ImageExecutionSingle, MaxOutputImages: 2}},
		{Execution: &ImageExecutionConfig{Mode: ImageExecutionNativeMulti, MaxOutputImages: 1}},
		{Execution: &ImageExecutionConfig{Mode: ImageExecutionProviderAsync, Provider: "other", MaxOutputImages: 2}},
	} {
		if _, err := PlanImageExecution(config, 1); err == nil {
			t.Fatalf("invalid config accepted: %+v", config)
		}
	}
	if p, err := PlanImageExecution(ImageConfig{Execution: &ImageExecutionConfig{Mode: ImageExecutionProviderAsync, Provider: "gemini_api", MaxOutputImages: 2}}, 3); err != nil || p.Mode != ImageExecutionProviderAsync {
		t.Fatalf("explicit async capability not classified: %+v, %v", p, err)
	}
}

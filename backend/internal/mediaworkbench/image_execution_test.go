package mediaworkbench

import "testing"

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

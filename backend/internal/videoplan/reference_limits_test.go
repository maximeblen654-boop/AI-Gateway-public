package videoplan

import "testing"

func TestReferenceThirtyAndContractIsolation(t *testing.T) {
	m := genericTestModel()
	m.Limits.Image = 30
	m.Limits.Total = 30
	for _, n := range []int{0, 1, 16, 20, 30, 31} {
		_, err := PreviewWithModel(m, m.Upstream, m.Resolutions[0], m.Ratios[0], m.Durations[0], n, 0, 0)
		if (err == nil) != (n <= 30) {
			t.Fatalf("n=%d err=%v", n, err)
		}
	}
	if _, err := PreviewWithModel(m, m.Upstream, m.Resolutions[0], m.Ratios[0], m.Durations[0], 0, 1, 0); err == nil {
		t.Fatal("unsupported video reference")
	}
	if _, err := PreviewWithModel(m, m.Upstream, m.Resolutions[0], m.Ratios[0], 4, 0, 0, 0); err == nil {
		t.Fatal("unsupported duration")
	}
	m.Mode = "inline_multimedia"
	m.Limits.Video = 10
	m.Limits.Audio = 10
	if _, err := PreviewWithModel(m, m.Upstream, m.Resolutions[0], m.Ratios[0], m.Durations[0], 20, 5, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := PreviewWithModel(m, m.Upstream, m.Resolutions[0], m.Ratios[0], m.Durations[0], 20, 6, 5); err == nil {
		t.Fatal("total limit ignored")
	}

}

package imagecontract

import "testing"

func TestLaoliMediaBaseScope(t *testing.T) {
	for _, v := range []string{"https://video.laoliimage2.win", "https://video.laoliimage2.win/v1", "https://video.laoliimage2.win:443/v1/"} {
		if !IsLaoliMediaBase(v) {
			t.Fatalf("rejected documented base %s", v)
		}
	}
	for _, v := range []string{"http://video.laoliimage2.win", "https://video.laoliimage2.win.evil", "https://video.laoliimage2.win:8443", "https://user@video.laoliimage2.win", "https://video.laoliimage2.win/v1?x=1", "https://video.laoliimage2.win/docs/", "https://video.laoliimage2.win/%76%31", "https://video.laoliimage2.win/#x"} {
		if IsLaoliMediaBase(v) {
			t.Fatalf("escaped origin scope %s", v)
		}
	}
}

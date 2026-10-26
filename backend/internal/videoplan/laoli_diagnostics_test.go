package videoplan

import "testing"

func TestLaoliExactContractIdentityDoesNotInventRatios(t *testing.T) {
	for _, id := range []string{"sd-native-full-2.0", "sd-native-full-2.5", "wan-3.0-video-ref", "wan-3.0-no-video-ref"} {
		if !IsLaoliMediaModel(id) {
			t.Fatalf("installed exact model is unknown: %s", id)
		}
		if _, ok := LaoliMediaModel(id, nil); ok {
			t.Fatalf("identity lookup made missing ratios executable: %s", id)
		}
	}
	for _, id := range []string{"", "unlisted-video", "sd-native-full-2.0-alias", " sd-native-full-2.0"} {
		if IsLaoliMediaModel(id) {
			t.Fatalf("identity lookup accepted a non-exact model: %q", id)
		}
	}
}

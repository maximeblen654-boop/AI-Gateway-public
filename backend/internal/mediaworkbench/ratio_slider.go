package mediaworkbench

import (
	"slices"
	"strings"
)

// AspectRatioSlider is an opt-in presentation of the existing finite sale domain.
// Continuous domains are deliberately unsupported until execution and price
// coverage can be verified without sampling or inventing a pricing rule.
type AspectRatioSlider struct {
	Enabled bool   `json:"enabled"`
	Mode    string `json:"mode"`
	Min     string `json:"min"`
	Max     string `json:"max"`
}

func ratioWithin(value, min, max string) bool {
	if strings.ContainsAny(value+min+max, "+-") {
		return false
	}
	a, b, ok := positivePair(value, ":")
	if !ok {
		return false
	}
	loA, loB, ok := positivePair(min, ":")
	if !ok {
		return false
	}
	hiA, hiB, ok := positivePair(max, ":")
	if !ok {
		return false
	}
	return int64(loA)*int64(hiB) <= int64(hiA)*int64(loB) && int64(a)*int64(loB) >= int64(loA)*int64(b) && int64(a)*int64(hiB) <= int64(hiA)*int64(b)
}
func validRatioSlider(p Product) bool {
	c := p.Capabilities
	v := c.AspectRatioSlider
	if v == nil {
		return true
	}
	if p.MediaType != "image" || v.Mode != "discrete" {
		return false
	}
	if !v.Enabled {
		return true
	}
	if !slices.Contains(c.AspectRatios, v.Min) || !slices.Contains(c.AspectRatios, v.Max) {
		return false
	}
	for _, ratio := range c.AspectRatios {
		if !ratioWithin(ratio, v.Min, v.Max) {
			return false
		}
	}
	return len(c.AspectRatios) > 0
}
func sliderAllows(v *AspectRatioSlider, ratio string) bool {
	return v == nil || !v.Enabled || v.Mode == "discrete" && ratioWithin(ratio, v.Min, v.Max)
}

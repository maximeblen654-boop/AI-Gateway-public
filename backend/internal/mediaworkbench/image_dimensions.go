package mediaworkbench

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

var ErrImageSpecMapping = errors.New("image_spec_mapping_mismatch: fixed dimensions and aspect ratio must agree with wire size; auto requires an automatic specification")
var pixelLabelPattern = regexp.MustCompile(`^[0-9]+x[0-9]+$`)

func positivePair(value, separator string) (int, int, bool) {
	parts := strings.Split(value, separator)
	if len(parts) != 2 {
		return 0, 0, false
	}
	a, e1 := strconv.Atoi(parts[0])
	b, e2 := strconv.Atoi(parts[1])
	return a, b, e1 == nil && e2 == nil && a > 0 && b > 0 && a <= 32768 && b <= 32768
}

func validateImageMapping(m SizeMapping) (int, int, error) {
	auto := func(v string) bool { return v == "" || v == "auto" }
	if m.WireSize == "auto" {
		if auto(m.Resolution) && auto(m.AspectRatio) {
			return 0, 0, nil
		}
		return 0, 0, ErrImageSpecMapping
	}
	w, h, ok := positivePair(m.WireSize, "x")
	if !ok || !dimensionPattern.MatchString(m.WireSize) || int64(w)*int64(h) > (128<<20)/4 {
		return 0, 0, ErrImageSpecMapping
	}
	// Named classes such as 1K do not define a pixel grid by themselves. Their
	// explicit administrator mapping is authoritative; do not invent a K/short-
	// side convention. An explicit pixel specification must retain both axes.
	if pixelLabelPattern.MatchString(m.Resolution) {
		if rw, rh, numeric := positivePair(m.Resolution, "x"); !numeric || rw != w || rh != h {
			return 0, 0, ErrImageSpecMapping
		}
	}
	if !auto(m.AspectRatio) {
		a, b, numeric := positivePair(m.AspectRatio, ":")
		if !numeric || int64(w)*int64(b) != int64(h)*int64(a) {
			return 0, 0, ErrImageSpecMapping
		}
	}
	return w, h, nil
}

// ImageDimensions is shared by preview and final request compilation. A wire
// size is the requested value, not a promise about the supplier's output pixels.
func ImageDimensions(config ImageConfig, spec Spec) (wire string, width, height int, err error) {
	if spec.Resolution == "" && spec.AspectRatio == "" {
		return "", 0, 0, nil // no fixed size was sold
	}
	for _, m := range config.SizeMappings {
		if m.Resolution == spec.Resolution && m.AspectRatio == spec.AspectRatio {
			width, height, err = validateImageMapping(m)
			return m.WireSize, width, height, err
		}
	}
	return "", 0, 0, errMissingMapping
}

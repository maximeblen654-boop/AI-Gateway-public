package mediaworkbench

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestExplicitDraftAddsTheOtherMediaTypeWithoutChangingPublishedSales(t *testing.T) {
	for _, first := range []string{"image", "video"} {
		t.Run(first+"_first", func(t *testing.T) {
			s, r, video := image2ProVideoFixture(t)
			image := validProduct()
			image.SiteModel, image.UpstreamModel = image2ProNewPublicModel, image2ProNewPublicModel
			r.a.Catalog.Models = []string{image.UpstreamModel, video.UpstreamModel}
			initial, next := image, video
			if first == "video" {
				initial, next = video, image
			}
			d, err := s.SaveDraft(t.Context(), 7, 0, DraftInput{Products: []Product{initial}})
			must(t, err)
			if !d.Config.Validation.PublishReady {
				t.Fatalf("initial product invalid: %+v", d.Config.Validation.Diagnostics)
			}
			d, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision)
			must(t, err)
			d, err = s.SetSales(t.Context(), 7, d.Config.RecordVersion, true)
			must(t, err)
			oldProduct := d.Config.Draft.Products[0]
			oldPublished, _ := json.Marshal(d.Config.Published)
			oldSales, _ := json.Marshal(d.Config.Sales)
			oldProcurement, _ := json.Marshal(d.Config.Procurement)
			status, schedulable, mapping := r.a.Status, r.a.Schedulable, r.a.ModelMapping
			baseVersion := d.Config.RecordVersion
			d, err = s.SaveDraft(t.Context(), 7, baseVersion, DraftInput{SubmissionID: "ca6e5d4c-1e33-4d7f-8a14-dc3aa1b12345", Products: []Product{oldProduct, next}})
			must(t, err)
			if !reflect.DeepEqual(d.Config.MediaTypes, []string{"image", "video"}) || !d.Config.Validation.PublishReady {
				t.Fatalf("explicit second media blocked: types=%v diagnostics=%+v", d.Config.MediaTypes, d.Config.Validation.Diagnostics)
			}
			if d.Config.AdapterBindings["image"].Kind != "openai_images" || d.Config.AdapterBindings["video"].Kind != "image2pro_video" {
				t.Fatalf("both native contracts were not bound: %+v", d.Config.AdapterBindings)
			}
			if !reflect.DeepEqual(d.Config.Draft.Products[0], oldProduct) {
				t.Fatal("existing product/specification/price changed")
			}
			published, _ := json.Marshal(d.Config.Published)
			sales, _ := json.Marshal(d.Config.Sales)
			procurement, _ := json.Marshal(d.Config.Procurement)
			if string(published) != string(oldPublished) || string(sales) != string(oldSales) || string(procurement) != string(oldProcurement) {
				t.Fatal("draft save changed published, sales or procurement")
			}
			if r.a.Status != status || r.a.Schedulable != schedulable || !reflect.DeepEqual(r.a.ModelMapping, mapping) {
				t.Fatal("native Account settings changed")
			}
			if d.Config.Draft.SaveReceipt == nil || d.Config.Draft.SaveReceipt.BaseRecordVersion != baseVersion {
				t.Fatal("normal CAS save receipt was lost")
			}
			writes := r.writes
			read, err := s.Detail(t.Context(), 7)
			must(t, err)
			if !reflect.DeepEqual(read.Config.MediaTypes, []string{"image", "video"}) || r.writes != writes {
				t.Fatal("readback lost types or wrote configuration")
			}
		})
	}
}

func TestMediaTypeExpansionRequiresAnExplicitValidCASDraft(t *testing.T) {
	s, r, video := image2ProVideoFixture(t)
	d, err := s.Initialize(t.Context(), 7, []string{"image"})
	must(t, err)
	before, _ := json.Marshal(r.a.Config)
	writes := r.writes
	read, err := s.Detail(t.Context(), 7)
	must(t, err)
	if !reflect.DeepEqual(read.Config.MediaTypes, []string{"image"}) || read.NativeAdapters["video"].Kind != "image2pro_video" || r.writes != writes {
		t.Fatal("read must expose native capabilities without migrating saved media types")
	}
	if _, err = s.SaveDraft(t.Context(), 7, d.Config.RecordVersion+1, DraftInput{Products: []Product{video}}); !errors.Is(err, ErrStale) {
		t.Fatalf("stale draft expanded media types: %v", err)
	}
	video.MediaType = "audio"
	if _, err = s.SaveDraft(t.Context(), 7, d.Config.RecordVersion, DraftInput{Products: []Product{video}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("arbitrary media type accepted: %v", err)
	}
	after, _ := json.Marshal(r.a.Config)
	if string(after) != string(before) || r.writes != writes {
		t.Fatal("rejected writes changed configuration")
	}
}

func TestMediaTypeExpansionPreservesUnknownAdapterAndModelGates(t *testing.T) {
	for _, scenario := range []string{"adapter", "model"} {
		t.Run(scenario, func(t *testing.T) {
			s, r, video := image2ProVideoFixture(t)
			if scenario == "adapter" {
				r.a.Platform = "gemini"
			} else {
				video.UpstreamModel, video.SiteModel = "not-in-catalog", "not-in-catalog"
			}
			d, err := s.Initialize(t.Context(), 7, []string{"image"})
			must(t, err)
			d, err = s.SaveDraft(t.Context(), 7, d.Config.RecordVersion, DraftInput{Products: []Product{video}})
			must(t, err)
			if d.Config.Validation.PublishReady {
				t.Fatal("expanding editable media bypassed native adapter/model validation")
			}
			if scenario == "model" && !hasCode(d.Config.Validation, "MODEL_NOT_DISCOVERED", "UI_FIXABLE") {
				t.Fatal("exact model identity gate lost")
			}
			if _, err = s.Publish(t.Context(), 7, d.Config.RecordVersion, d.Config.Draft.Revision); !errors.Is(err, ErrValidation) {
				t.Fatalf("unsupported product published: %v", err)
			}
		})
	}
}

func TestSavingOneMediaDoesNotShrinkExistingTypes(t *testing.T) {
	s, r := validatorFixture(t)
	d, err := s.SaveDraft(t.Context(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{validProduct()}})
	must(t, err)
	if !reflect.DeepEqual(d.Config.MediaTypes, []string{"image", "video"}) {
		t.Fatal("saving only images removed the existing video type")
	}
}

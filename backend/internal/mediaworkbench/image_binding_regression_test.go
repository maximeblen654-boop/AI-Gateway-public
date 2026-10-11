package mediaworkbench

import (
	"context"
	"testing"
)

func TestImageBindingsForNewAndExistingAccounts(t *testing.T) {
	t.Run("initialize derives native OpenAI image binding", func(t *testing.T) {
		s, r := fixture()
		d, err := s.Initialize(context.Background(), 7, []string{"image"})
		must(t, err)
		binding := d.Config.AdapterBindings["image"]
		want, ok := Descriptor("openai_images")
		if !ok {
			t.Fatal("openai image descriptor missing")
		}
		if binding != (AdapterBinding{Kind: want.Kind, Revision: want.Revision, Auth: want.Auth, TaskFlow: want.TaskFlow}) {
			t.Fatalf("native binding = %+v", binding)
		}
		if r.a.Config.AdapterBindings["image"] != binding {
			t.Fatal("native binding was not persisted")
		}
	})

	t.Run("first explicit save derives native OpenAI image binding", func(t *testing.T) {
		s, r := fixture()
		r.a.BaseURL = "https://supplier.example/v1"
		r.a.Catalog.Models = []string{"gpt-image-2"}
		d, err := s.SaveDraft(context.Background(), 7, 0, DraftInput{Products: []Product{validProduct()}})
		must(t, err)
		binding := d.Config.AdapterBindings["image"]
		if binding.Kind != "openai_images" || binding.Auth != "account_apikey" || binding.TaskFlow != "sync" {
			t.Fatalf("first-save binding = %+v", binding)
		}
		if !d.Config.Validation.PublishReady {
			t.Fatalf("first-save native binding did not validate: %+v", d.Config.Validation.Diagnostics)
		}
	})

	t.Run("legacy unbound image is refreshed before save validation", func(t *testing.T) {
		s, r := fixture()
		_, err := s.Initialize(context.Background(), 7, []string{"image"})
		must(t, err)
		// This is the placeholder persisted by an older configuration before a
		// native image adapter became available for the Account.
		r.a.Config.AdapterBindings["image"] = AdapterBinding{Kind: "unbound_image", Auth: "account_apikey"}

		d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{validProduct()}})
		must(t, err)
		if d.Config.AdapterBindings["image"].Kind != "openai_images" {
			t.Fatalf("legacy binding was retained: %+v", d.Config.AdapterBindings["image"])
		}
		if !d.Config.Validation.PublishReady {
			t.Fatalf("legacy binding blocked valid image draft: %+v", d.Config.Validation.Diagnostics)
		}
	})

	t.Run("existing valid binding remains account-owned", func(t *testing.T) {
		s, r := fixture()
		_, err := s.Initialize(context.Background(), 7, []string{"image"})
		must(t, err)
		binding := AdapterBinding{Kind: "openai_images", Revision: "stale_revision", Auth: "account_apikey", TaskFlow: "sync"}
		r.a.Config.AdapterBindings["image"] = binding

		d, err := s.SaveDraft(context.Background(), 7, r.a.Config.RecordVersion, DraftInput{Products: []Product{validProduct()}})
		must(t, err)
		want, _ := Descriptor("openai_images")
		binding.Revision = want.Revision
		if got := d.Config.AdapterBindings["image"]; got != binding {
			t.Fatalf("existing binding changed unexpectedly: got=%+v want=%+v", got, binding)
		}
	})
}
